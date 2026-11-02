// mnemo-touch-id: Touch ID unlock backed by the Secure Enclave.
//
// The main process starts this helper once per request, writes one JSON
// request to its stdin, and reads one JSON reply from its stdout. It keeps
// nothing between runs and holds no vault data: it only creates a Secure
// Enclave key and performs one key agreement with it. The protocol, and
// what it means if another process runs this helper, are described in
// docs/THREAT_MODEL.md ("Touch ID helper").
//
// Requests and replies (binary values are base64):
//   {"command":"status"}
//     -> {"available": bool}   Secure Enclave present and a fingerprint enrolled
//   {"command":"create"}
//     -> {"publicKey": X9.63 P-256 point, "keyBlob": Secure Enclave key blob}
//        The private key never leaves the Secure Enclave; the blob only opens
//        on this Mac's Secure Enclave. Using it needs Touch ID with the
//        fingerprints enrolled now (.biometryCurrentSet).
//   {"command":"agree","keyBlob":…,"peerPublicKey":…,"reason":…,"interactive":bool}
//     -> {"sharedSecret": 32 bytes}  ECDH of the blob's key with the peer key,
//        after Touch ID. "reason" is shown in the prompt. With
//        "interactive": false (tests) no prompt is shown and the request fails.
// Errors: {"error": "canceled" | "unavailable" | "invalidated" |
//   "interactionRequired" | "invalidRequest" | "failed"} and exit status 1.
import CryptoKit
import Foundation
import LocalAuthentication
import Security

let maxRequestBytes = 64 * 1024
let maxReasonLength = 200

struct Request: Decodable {
  let command: String
  let keyBlob: String?
  let peerPublicKey: String?
  let reason: String?
  let interactive: Bool?
}

func reply(_ object: [String: Any], status: Int32 = 0) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: object) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  exit(status)
}

func fail(_ code: String) -> Never {
  reply(["error": code], status: 1)
}

// LocalAuthentication and Security errors, also when wrapped by CryptoKit.
func classify(_ error: Error) -> String {
  var pending: [NSError] = [error as NSError]
  while let current = pending.popLast() {
    if current.domain == LAError.errorDomain {
      switch LAError.Code(rawValue: current.code) {
      case .userCancel, .appCancel, .systemCancel, .userFallback, .authenticationFailed:
        return "canceled"
      case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet:
        return "unavailable"
      case .notInteractive:
        return "interactionRequired"
      case .invalidContext:
        return "invalidated"
      default:
        break
      }
    }
    if current.domain == NSOSStatusErrorDomain,
       current.code == Int(errSecAuthFailed) || current.code == Int(errSecItemNotFound) {
      return "invalidated"
    }
    if let underlying = current.userInfo[NSUnderlyingErrorKey] as? NSError {
      pending.append(underlying)
    }
  }
  return "failed"
}

let input = FileHandle.standardInput.readData(ofLength: maxRequestBytes + 1)
guard input.count <= maxRequestBytes,
      let request = try? JSONDecoder().decode(Request.self, from: input) else {
  fail("invalidRequest")
}

switch request.command {
case "status":
  var error: NSError?
  let biometry = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
  reply(["available": SecureEnclave.isAvailable && biometry])

case "create":
  guard SecureEnclave.isAvailable else { fail("unavailable") }
  guard let access = SecAccessControlCreateWithFlags(
    nil,
    kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    [.privateKeyUsage, .biometryCurrentSet],
    nil
  ) else {
    fail("failed")
  }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
    reply([
      "publicKey": key.publicKey.x963Representation.base64EncodedString(),
      "keyBlob": key.dataRepresentation.base64EncodedString(),
    ])
  } catch {
    fail(classify(error))
  }

case "agree":
  guard let blobText = request.keyBlob, let blob = Data(base64Encoded: blobText),
        let peerText = request.peerPublicKey, let peerData = Data(base64Encoded: peerText),
        let reason = request.reason, !reason.isEmpty, reason.count <= maxReasonLength else {
    fail("invalidRequest")
  }
  guard SecureEnclave.isAvailable else { fail("unavailable") }
  let context = LAContext()
  context.localizedReason = reason
  // Every agreement needs its own touch.
  context.touchIDAuthenticationAllowableReuseDuration = 0
  context.interactionNotAllowed = request.interactive == false
  let peer: P256.KeyAgreement.PublicKey
  do {
    peer = try P256.KeyAgreement.PublicKey(x963Representation: peerData)
  } catch {
    fail("invalidRequest")
  }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
    let secret = try key.sharedSecretFromKeyAgreement(with: peer)
    let bytes = secret.withUnsafeBytes { Data($0) }
    reply(["sharedSecret": bytes.base64EncodedString()])
  } catch {
    fail(classify(error))
  }

default:
  fail("invalidRequest")
}

(() => {
  const ns = window.mnemoRenderer;

  function setSiteIcon(container, favicon, fallbackText) {
    container.replaceChildren();
    container.classList.remove("has-site-icon");
    const fallback = document.createElement("span");
    fallback.className = "site-icon-fallback";
    fallback.textContent = fallbackText || "•";
    container.append(fallback);

    if (typeof favicon !== "string" || !favicon.startsWith("data:image/png;base64,")) return;
    const image = document.createElement("img");
    image.className = "site-icon-image";
    image.alt = "";
    image.draggable = false;
    image.addEventListener("error", () => {
      image.remove();
      container.classList.remove("has-site-icon");
    }, { once: true });
    image.addEventListener("load", () => container.classList.add("has-site-icon"), { once: true });
    container.append(image);
    image.src = favicon;
  }

  ns.entities.login.setSiteIcon = setSiteIcon;
})();

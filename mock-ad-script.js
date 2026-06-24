(() => {
  const scriptUrl = new URL(document.currentScript?.src ?? location.href);
  const fill = scriptUrl.searchParams.get("fill") !== "0";
  const queue = window.adsbygoogle = window.adsbygoogle || [];
  const nativePush = Array.prototype.push;

  function renderPending() {
    document.querySelectorAll("ins.adsbygoogle:not([data-mock-provider-rendered])").forEach((ins) => {
      ins.setAttribute("data-mock-provider-rendered", "true");
      ins.setAttribute("data-adsbygoogle-status", "done");

      window.setTimeout(() => {
        if (!fill) {
          ins.setAttribute("data-ad-status", "unfilled");
          return;
        }

        ins.setAttribute("data-ad-status", "filled");
        const creative = document.createElement("div");
        creative.style.cssText = [
          "display:flex",
          "width:100%",
          "height:100%",
          "align-items:center",
          "justify-content:center",
          "background:#111827",
          "color:#fff",
          "font:700 14px/1.2 system-ui,sans-serif",
          "letter-spacing:0"
        ].join(";");
        creative.textContent = "MOCK NETWORK AD";
        ins.appendChild(creative);
      }, 220);
    });
  }

  queue.push = function pushMockProviderAd() {
    const result = nativePush.apply(queue, arguments);
    renderPending();
    return result;
  };

  renderPending();
})();

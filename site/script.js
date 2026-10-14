// Progressive enhancement: install commands remain selectable without JavaScript.
const button = document.querySelector("[data-copy]");
const status = document.querySelector(".copy-status");
if (button && status) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const code = document.getElementById(button.dataset.copy);
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      status.textContent = "Copied. Run these commands inside herdr.";
    } catch {
      // Clipboard may be unavailable on HTTP, file URLs or restricted browsers.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = "Select and copy the commands above with Ctrl+C or ⌘C.";
    }
  });
}

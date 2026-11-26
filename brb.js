"use strict";
// "Be right back" frame drawing, shared by the phone page (app.js) and the
// relay (server/brb-stream.js, which streams the same picture when the phone drops off).
(function (root) {
  const SIZES = { landscape: [1280, 720], portrait: [720, 1280] };
  const PAPER = "#efebe4";

  /**
   * Draw one frame. `under` (optional) is drawn first and the BRB picture is
   * faded in over it with `alpha` (0..1); without it the fade is from black.
   */
  function draw(ctx, orient, img, alpha = 1, under = null) {
    const [W, H] = SIZES[orient];
    if (alpha < 1) {
      if (under) under(ctx, W, H); else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    if (img) {
      // cover-fit
      const s = Math.max(W / img.width, H / img.height);
      const w = img.width * s, h = img.height * s;
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    } else { ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
  }

  root.gikocamBrb = { SIZES, draw };
})(typeof window !== "undefined" ? window : globalThis);

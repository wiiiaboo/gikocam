// Server-side "be right back" stream.
//
// When the phone goes quiet (lost signal, app in the background) the relay
// keeps the stream slot alive by publishing the BRB picture itself, through the
// same gikopoipoi user and slot. The relay requests the slot; once gikopoipoi
// says ok it calls connect(), which publishes like the phone does (offer, then
// the answer). When the phone comes back this one is closed.
import path from "node:path";
import { pathToFileURL } from "node:url";
import wrtc from "@roamhq/wrtc";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const { RTCPeerConnection, MediaStream, nonstandard: { RTCVideoSource, rgbaToI420 } } = wrtc;
const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] };
const FADE_MS = 1000;

let assets = null;
async function loadAssets(pageDir) {
  if (!assets) {
    assets = (async () => {
      await import(pathToFileURL(path.join(pageDir, "brb.js")).href); // sets globalThis.gikocamBrb
      const imgs = {};
      for (const o of ["landscape", "portrait"]) {
        imgs[o] = await loadImage(path.join(pageDir, "brb", o + ".webp")).catch(() => null);
      }
      return { brb: globalThis.gikocamBrb, imgs };
    })();
  }
  return assets;
}

export class BrbStream {
  /** @param {{pageDir:string, slot:number, orient:string, emit:Function, log:Function}} o */
  constructor(o) {
    Object.assign(this, o);
    if (this.orient !== "portrait") this.orient = "landscape";
    this.pc = null; this.pump = null; this.stopped = false; this.retry = 0;
  }

  async start() {
    const { brb, imgs } = await loadAssets(this.pageDir);
    if (this.stopped) return;
    const [W, H] = brb.SIZES[this.orient];
    const canvas = createCanvas(W, H), ctx = canvas.getContext("2d");
    const i420 = new Uint8ClampedArray(W * H * 1.5);
    this.source = new RTCVideoSource();
    this.track = this.source.createTrack();
    const t0 = Date.now();
    let settled = false;
    const frame = { width: W, height: H, data: i420 };
    // Fade in from black at 15 fps; after that the same picture is resent.
    this.pump = setInterval(() => {
      if (!settled) {
        const a = Math.min(1, (Date.now() - t0) / FADE_MS);
        brb.draw(ctx, this.orient, imgs[this.orient], a);
        rgbaToI420({ width: W, height: H, data: ctx.getImageData(0, 0, W, H).data }, frame);
        settled = a >= 1;
      }
      this.source.onFrame(frame);
    }, 66);
  }

  async connect() {
    if (this.stopped) return;
    if (!this.track) { setTimeout(() => this.connect(), 200); return; } // assets still loading
    if (this.pc) this.pc.close();
    const pc = new RTCPeerConnection(ICE);
    this.pc = pc;
    pc.addTrack(this.track, new MediaStream([this.track]));
    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const st = pc.iceConnectionState;
      if ((st === "connected" || st === "completed") && !this.live) {
        this.live = true; this.retry = 0; this.log("brb_live", { slot: this.slot });
        // One stats line a few seconds in, to show frames are going out.
        setTimeout(async () => {
          if (this.pc !== pc) return;
          const stats = await pc.getStats().catch(() => null);
          stats?.forEach((r) => {
            if (r.type === "outbound-rtp" && r.kind === "video") {
              this.log("brb_sending", { frames: r.framesEncoded, bytes: r.bytesSent, size: `${r.frameWidth}x${r.frameHeight}` });
            }
          });
        }, 5000);
      }
      else if (st === "disconnected" || st === "closed") this.live = false;
      else if (st === "failed") this.reconnectLater();
    };
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      this.pendingOffer = offer.sdp;
      this.emit("user-rtc-message", { streamSlotId: this.slot, type: "offer", msg: offer.sdp });
    } catch (e) {
      this.log("brb_offer_failed", { message: String(e.message || e) });
      this.reconnectLater();
    }
  }

  reconnectLater() {
    if (this.stopped) return;
    setTimeout(() => this.connect(), Math.min(15_000, 1000 * 2 ** this.retry++));
  }

  /** server-rtc-message for our slot. */
  async onRtc(type, msg) {
    const pc = this.pc;
    if (!pc || this.stopped) return;
    try {
      if (type === "answer" && typeof msg === "string") {
        if (this.pendingOffer) { await pc.setLocalDescription({ type: "offer", sdp: this.pendingOffer }); this.pendingOffer = null; }
        await pc.setRemoteDescription({ type: "answer", sdp: msg });
      } else if (type === "candidate" && msg) {
        await pc.addIceCandidate(msg);
      }
    } catch (e) {
      this.log("brb_rtc_error", { message: String(e.message || e) });
      this.reconnectLater();
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pump);
    if (this.pc) this.pc.close();
    if (this.track) this.track.stop();
    this.pc = null;
  }
}

(async () => {
  "use strict";

  /* ===== Settings ===== */
  /* Target video height; the closest height at or below this is used */
  const TARGET_HEIGHT = 720;
  /* Set to 10 for a quick test, Infinity for the whole video */
  const MAX_SEGMENTS = Infinity;
  /* Leave empty to auto-detect the .mpd the page loaded, or paste the manifest URL */
  const MPD_URL = "";
  /* Segments downloaded at the same time (6 is a good default; lower it if errors appear) */
  const PARALLEL = 6;

  /* ===== On-screen status (Android has no visible console) ===== */
  const box = document.createElement("div");
  /* At the top (Android's toolbar can cover the bottom), immune to page CSS */
  box.style.cssText =
    "all:initial;position:fixed!important;z-index:2147483647!important;" +
    "top:calc(8px + env(safe-area-inset-top,0px));left:8px;right:8px;" +
    "display:block!important;visibility:visible!important;opacity:1!important;" +
    "padding:10px 12px;background:rgba(0,0,0,.88);color:#fff;" +
    "font:14px/1.4 sans-serif;border-radius:8px;word-break:break-word;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none";
  const label = document.createElement("div");
  const track = document.createElement("div");
  const bar = document.createElement("div");
  track.style.cssText =
    "display:none;height:8px;margin-top:8px;background:rgba(255,255,255,.2);" +
    "border-radius:4px;overflow:hidden";
  bar.style.cssText =
    "height:100%;width:0;background:#4caf50;transition:width .3s";
  track.appendChild(bar);
  box.append(label, track);

  /* Keep the box attached and visible, also when the player goes fullscreen */
  let keepBox = true;
  function attachBox() {
    if (!keepBox) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const host = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
    if (box.parentNode !== host) host.appendChild(box);
  }
  attachBox();
  document.addEventListener("fullscreenchange", attachBox);
  document.addEventListener("webkitfullscreenchange", attachBox);
  const keepTimer = setInterval(attachBox, 1000);
  const removeBox = () => {
    keepBox = false;
    clearInterval(keepTimer);
    box.parentNode && box.parentNode.removeChild(box);
  };

  const status = s => { label.textContent = s; console.log(s); };

  /* Progress bar with percentage, size, speed and time left */
  const startTime = Date.now();
  let bytesDone = 0;
  const mb = n => (n / 1048576).toFixed(1);
  const clock = s => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };
  function progress(done, total) {
    const elapsed = (Date.now() - startTime) / 1000;
    const pct = done / total * 100;
    const speed = bytesDone / Math.max(elapsed, 0.001);
    const left = done ? elapsed / done * (total - done) : NaN;
    track.style.display = "block";
    bar.style.width = pct.toFixed(1) + "%";
    label.textContent =
      `${pct.toFixed(1)}% · ${done}/${total} segmenti · ${mb(bytesDone)} MB · ` +
      `${mb(speed)} MB/s · mancano ${Number.isFinite(left) ? clock(left) : "…"}`;
    document.title = `${Math.floor(pct)}% – download`;
  }

  /* ===== Find the manifest ===== */
  /* Make room so new requests keep being recorded */
  try { performance.setResourceTimingBufferSize(100000); } catch (e) {}

  const isMpd = u => /\.mpd(\?|#|$)/i.test(u);

  /* Look in this page and in any same-site frames */
  function detectMpd() {
    const windows = [window];
    for (const f of document.querySelectorAll("iframe")) {
      try { if (f.contentWindow.performance) windows.push(f.contentWindow); } catch (e) {}
    }
    for (const w of windows) {
      try {
        const hit = w.performance.getEntriesByType("resource")
          .map(e => e.name).filter(isMpd).pop();
        if (hit) return hit;
      } catch (e) {}
    }
    return "";
  }

  /* Start the player if the manifest isn't loaded yet */
  function startPlayer() {
    const videos = [...document.querySelectorAll("video")];
    for (const v of videos) {
      v.muted = true;
      v.play().catch(() => {});
    }
    if (!videos.length) {
      const btn = document.querySelector(
        ".vjs-big-play-button, .jw-display-icon-display, " +
        "button[aria-label*='play' i], [class*='play-button' i], [class*='playButton' i]"
      );
      if (btn) btn.click();
    }
  }

  async function findMpd(timeoutMs = 30000) {
    let url = MPD_URL || detectMpd();
    if (url) return url;

    status("Manifest non trovato: avvio il video…");
    startPlayer();

    const end = Date.now() + timeoutMs;
    let lastKick = Date.now();
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, 500));
      url = detectMpd();
      if (url) return url;
      if (Date.now() - lastKick > 5000) {
        startPlayer();
        lastKick = Date.now();
      }
    }

    /* Last resort: ask */
    return prompt("Manifest non trovato. Incolla l'URL dell'MPD:", "") || "";
  }

  /* ===== MP4 box helpers ===== */
  const view = bytes =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function boxes(bytes, from = 0, to = bytes.length) {
    const v = view(bytes);
    const result = [];

    for (let p = from; p < to;) {
      if (p + 8 > to) throw Error("Incomplete MP4 box header");

      let size = v.getUint32(p);
      let header = 8;

      if (size === 1) {
        if (p + 16 > to) throw Error("Incomplete large MP4 box");
        size = Number(v.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) {
        size = to - p;
      }

      if (!Number.isSafeInteger(size) || size < header || p + size > to) {
        throw Error(`Invalid MP4 box at byte ${p}`);
      }

      result.push({
        type: String.fromCharCode(...bytes.subarray(p + 4, p + 8)),
        start: p,
        body: p + header,
        end: p + size
      });

      p += size;
    }

    return result;
  }

  function find(bytes, type, from = 0, to = bytes.length) {
    const found = boxes(bytes, from, to).find(b => b.type === type);
    if (!found) throw Error(`Missing ${type} box`);
    return found;
  }

  const copy = (bytes, b) => bytes.slice(b.start, b.end);

  function makeBox(type, ...parts) {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    if (size >= 2 ** 32) throw Error("Box exceeds 4 GiB");

    const out = new Uint8Array(size);
    view(out).setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);

    let offset = 8;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  /* Merge video and audio init segments, giving audio its own track ID */
  function combine(videoInit, audioInit) {
    const ftyp = copy(videoInit, find(videoInit, "ftyp"));
    const vm = copy(videoInit, find(videoInit, "moov"));
    const am = copy(audioInit, find(audioInit, "moov"));

    const vt = copy(vm, find(vm, "trak", 8));
    const at = copy(am, find(am, "trak", 8));

    const vtkhd = find(vt, "tkhd", 8);
    const atkhd = find(at, "tkhd", 8);

    const vOffset = vtkhd.start + (vt[vtkhd.body] === 1 ? 28 : 20);
    const aOffset = atkhd.start + (at[atkhd.body] === 1 ? 28 : 20);

    const videoTrack = view(vt).getUint32(vOffset);
    const audioTrack = videoTrack === 1 ? 2 : 1;

    view(at).setUint32(aOffset, audioTrack);

    const amvex = copy(am, find(am, "mvex", 8));
    const trex = copy(amvex, find(amvex, "trex", 8));
    view(trex).setUint32(12, audioTrack);

    if (!boxes(vm, 8).some(b => b.type === "mvex")) {
      throw Error("Missing movie extends box");
    }

    const children = boxes(vm, 8).map(b => {
      const child = copy(vm, b);

      if (b.type === "mvhd") {
        view(child).setUint32(
          child.length - 4,
          Math.max(videoTrack, audioTrack) + 1
        );
      }

      if (b.type === "mvex") {
        return makeBox(
          "mvex",
          ...boxes(child, 8).map(c => copy(child, c)),
          trex
        );
      }

      return child;
    });

    return {
      ftyp,
      moov: makeBox("moov", ...children, at),
      videoTrack,
      audioTrack
    };
  }

  /* Rewrite sequence number and track ID; keep only moof + mdat */
  function fragment(input, trackId, sequence) {
    const data = input.slice();
    const outer = boxes(data);

    const moof = outer.find(b => b.type === "moof");
    const mdat = outer.find(b => b.type === "mdat");
    if (!moof || !mdat) throw Error("Missing moof or mdat");

    const children = boxes(data, moof.body, moof.end);

    const mfhd = children.find(b => b.type === "mfhd");
    if (!mfhd) throw Error("Missing mfhd");
    view(data).setUint32(mfhd.start + 12, sequence);

    for (const traf of children.filter(b => b.type === "traf")) {
      const tfhd = find(data, "tfhd", traf.body, traf.end);
      const flags = view(data).getUint32(tfhd.start + 8) & 0xffffff;

      if (!(flags & 0x020000) || (flags & 0x000001)) {
        throw Error("Unsupported tfhd base-data-offset mode");
      }

      view(data).setUint32(tfhd.start + 12, trackId);
    }

    return [copy(data, moof), copy(data, mdat)];
  }

  /* ===== MPD helpers ===== */
  const kids = (el, name) =>
    el ? [...el.children].filter(c => c.localName === name) : [];
  const child = (el, name) => kids(el, name)[0] || null;

  function isoDuration(s) {
    if (!s) return NaN;
    const m = /^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/
      .exec(s.trim());
    if (!m) return NaN;
    const [, d = 0, h = 0, mi = 0, se = 0] = m;
    return Number(d) * 86400 + Number(h) * 3600 + Number(mi) * 60 + Number(se);
  }

  /* Fill $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$ */
  function fill(tpl, vars) {
    return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (m, key, width) => {
      if (key === "") return "$";
      if (vars[key] === undefined || vars[key] === null) {
        throw Error(`Unknown template variable ${key}`);
      }
      const s = String(vars[key]);
      return width ? s.padStart(Number(width), "0") : s;
    });
  }

  /* SegmentTemplate attributes inherit Period -> AdaptationSet -> Representation */
  function template(levels) {
    const t = {};
    let timeline = null;

    for (const el of levels) {
      const st = child(el, "SegmentTemplate");
      if (!st) continue;
      for (const a of st.attributes) t[a.name] = a.value;
      const tl = child(st, "SegmentTimeline");
      if (tl) timeline = tl;
    }

    return Object.keys(t).length ? { t, timeline } : null;
  }

  function segmentList({ t, timeline }, periodSeconds) {
    const startNumber = Number(t.startNumber ?? 1);
    const timescale = Number(t.timescale ?? 1);
    const out = [];

    if (timeline) {
      const S = kids(timeline, "S");
      let time = 0;
      let number = startNumber;

      S.forEach((s, i) => {
        if (s.hasAttribute("t")) time = Number(s.getAttribute("t"));
        const d = Number(s.getAttribute("d"));
        let r = Number(s.getAttribute("r") ?? 0);

        if (r < 0) {
          const next = S[i + 1];
          const end = next && next.hasAttribute("t")
            ? Number(next.getAttribute("t"))
            : Number(t.presentationTimeOffset ?? 0) + periodSeconds * timescale;
          if (!Number.isFinite(end)) throw Error("Open-ended timeline (live stream?)");
          r = Math.ceil((end - time) / d) - 1;
        }

        for (let k = 0; k <= r; k++) {
          out.push({ number: number++, time });
          time += d;
        }
      });

    } else if (t.duration) {
      if (!Number.isFinite(periodSeconds)) {
        throw Error("Unknown video duration (live stream?)");
      }
      const d = Number(t.duration);
      const count = Math.ceil(periodSeconds * timescale / d - 1e-9);
      for (let k = 0; k < count; k++) {
        out.push({ number: startNumber + k, time: k * d });
      }

    } else {
      throw Error("SegmentTemplate has neither duration nor SegmentTimeline");
    }

    return out;
  }

  /* ===== Network ===== */
  async function get(url, tries = 3) {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      } catch (e) {
        if (attempt >= tries) {
          throw Error(`${url.split("/").pop()}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  /* ===== Output: file picker on desktop Chrome, Blob download elsewhere ===== */
  async function openOutput(getName) {
    if (typeof showSaveFilePicker === "function") {
      try {
        const handle = await showSaveFilePicker({
          suggestedName: getName(),
          types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }]
        });
        const w = await handle.createWritable();
        return {
          name: () => handle.name,
          write: p => w.write(p),
          close: () => w.close(),
          abort: () => w.abort()
        };
      } catch (e) {
        if (e.name === "AbortError") return null;
        /* SecurityError (iframe, no gesture) etc: fall back to Blob */
      }
    }

    /* Roll chunks into Blobs regularly so Chrome can move them out of page memory */
    let blobs = [];
    let pending = [];

    let finalName = "";
    return {
      name: () => finalName || getName(),
      write(p) {
        pending.push(p);
        if (pending.length >= 100) {
          blobs.push(new Blob(pending));
          pending = [];
        }
      },
      close() {
        const blob = new Blob([...blobs, ...pending], { type: "video/mp4" });
        blobs = pending = null;

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = finalName = getName();
        a.textContent = "Tap here if the download didn't start";
        a.style.cssText = "display:block;margin-top:6px;color:#8cf;pointer-events:auto";
        box.appendChild(a);
        a.click();
      },
      abort() {
        blobs = pending = null;
      }
    };
  }

  /* ===== Main ===== */
  /* File name from the title shown next to the player (available once it plays) */
  function fileName() {
    let title = "";
    try {
      title = document.querySelector("video").parentNode.innerText.split("\n")[0];
    } catch (e) {}
    title = (title || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "video";
    return (MAX_SEGMENTS === Infinity ? title : "test_" + title) + ".mp4";
  }

  /* Open the save dialog first, while the bookmark click still counts as a user gesture */
  const out = await openOutput(fileName);
  if (!out) {
    removeBox();
    return;
  }

  let completed = 0;
  let initialized = false;

  try {
    status("v4 · Cerco il manifest…");
    const mpdUrl = await findMpd();
    if (!mpdUrl) throw Error("Nessun URL MPD");

    status("Carico il manifest…");
    const mpdText = new TextDecoder().decode(await get(mpdUrl));
    const xml = new DOMParser().parseFromString(mpdText, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) {
      throw Error("The manifest is not valid XML");
    }

    const mpd = xml.documentElement;

    if (mpd.getAttribute("type") === "dynamic") {
      throw Error("Live streams are not supported");
    }

    if (xml.getElementsByTagNameNS("*", "ContentProtection").length) {
      throw Error("This stream is DRM-protected and can't be saved");
    }

    const periods = kids(mpd, "Period");
    if (!periods.length) throw Error("No Period in manifest");
    if (periods.length > 1) console.warn("Several periods found; only the first is saved");
    const period = periods[0];

    const periodSeconds = isoDuration(period.getAttribute("duration")) ||
      isoDuration(mpd.getAttribute("mediaPresentationDuration")) -
      (isoDuration(period.getAttribute("start")) || 0);

    /* List every representation with its kind, height and bitrate */
    const reps = kids(period, "AdaptationSet").flatMap(as =>
      kids(as, "Representation").map(r => ({
        as,
        r,
        kind: (
          as.getAttribute("contentType") ||
          r.getAttribute("mimeType") ||
          as.getAttribute("mimeType") || ""
        ).split("/")[0],
        height: Number(r.getAttribute("height") || as.getAttribute("height") || 0),
        bw: Number(r.getAttribute("bandwidth") || 0)
      }))
    );

    const videos = reps.filter(x => x.kind === "video")
      .sort((a, b) => a.height - b.height || a.bw - b.bw);
    const audios = reps.filter(x => x.kind === "audio")
      .sort((a, b) => a.bw - b.bw);

    if (!videos.length) throw Error("No video in manifest");
    if (!audios.length) throw Error("No audio in manifest");

    const videoRep = videos.filter(v => v.height <= TARGET_HEIGHT).pop() || videos[0];
    const audioRep = audios[audios.length - 1];

    /* Resolve init + media URLs for one representation */
    function track(x) {
      const levels = [period, x.as, x.r];
      const info = template(levels);
      if (!info) throw Error("Only SegmentTemplate manifests are supported");
      if (!info.t.initialization || !info.t.media) {
        throw Error("SegmentTemplate is missing initialization or media");
      }

      let base = mpdUrl;
      for (const el of [mpd, ...levels]) {
        const b = child(el, "BaseURL");
        if (b) base = new URL(b.textContent.trim(), base).href;
      }

      const vars = {
        RepresentationID: x.r.getAttribute("id"),
        Bandwidth: x.r.getAttribute("bandwidth")
      };

      const segs = segmentList(info, periodSeconds).slice(0, MAX_SEGMENTS);

      return {
        init: new URL(fill(info.t.initialization, vars), base).href,
        media: segs.map(s =>
          new URL(fill(info.t.media, { ...vars, Number: s.number, Time: s.time }), base).href
        )
      };
    }

    const video = track(videoRep);
    const audio = track(audioRep);

    status(`Video ${videoRep.height}p, ${video.media.length} video / ${audio.media.length} audio segments`);

    const [videoInit, audioInit] = await Promise.all([
      get(video.init),
      get(audio.init)
    ]);

    const combined = combine(videoInit, audioInit);
    await out.write(combined.ftyp);
    await out.write(combined.moov);
    initialized = true;

    const pageTitle = document.title;
    /* Interleave video and audio in playback order */
    const jobs = [];
    const pairs = Math.max(video.media.length, audio.media.length);
    for (let i = 0; i < pairs; i++) {
      if (i < video.media.length) jobs.push({ url: video.media[i], trackId: combined.videoTrack });
      if (i < audio.media.length) jobs.push({ url: audio.media[i], trackId: combined.audioTrack });
    }

    /* Download several segments at once, but write them strictly in order */
    const total = jobs.length;
    const pending = new Map();
    let launched = 0;
    const launch = () => {
      while (launched < total && launched < completed + PARALLEL) {
        const p = get(jobs[launched].url);
        p.catch(() => {});
        pending.set(launched++, p);
      }
    };

    for (let i = 0; i < total; i++) {
      launch();
      const bytes = await pending.get(i);
      pending.delete(i);
      bytesDone += bytes.length;
      for (const part of fragment(bytes, jobs[i].trackId, i + 1)) {
        await out.write(part);
      }
      completed = i + 1;
      progress(completed, total);
    }

    await out.close();
    document.title = pageTitle;
    bar.style.background = "#2196f3";
    status(`Completato: ${completed} segmenti, ${mb(bytesDone)} MB in ${clock((Date.now() - startTime) / 1000)} → ${out.name()}`);
    setTimeout(removeBox, 60000);

  } catch (error) {
    console.error(error);

    if (initialized && completed > 0) {
      try { await out.close(); } catch (e) { console.error(e); }
      status(`Stopped after ${completed} segments (partial file kept): ${error.message}`);
    } else {
      try { await out.abort(); } catch (e) { console.error(e); }
      status(`Error: ${error.message}`);
    }

    setTimeout(removeBox, 60000);
  }
})();

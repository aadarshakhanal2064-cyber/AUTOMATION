// ════════════════════════════════════════════
//  VISION ENGINE
//  Structural document geometry for scanned pages — deskew and table-line
//  detection — via plain <canvas> pixel math. No OpenCV.js: prototyped and
//  measured directly against real rotated IRD VAT scans (see HANDOFF-era
//  investigation) and it fully solved the actual failure (rotation
//  defeating fixed-fraction crop coordinates) without a ~8MB dependency.
//  Reusable by any future module that reads a scanned tabular form, not
//  VAT-specific.
// ════════════════════════════════════════════
window.VisionEngine = (function () {
  function isDark(data, width, x, y, threshold) {
    const i = (y * width + x) * 4;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum < threshold;
  }

  function rowDarkFraction(imageData, width, y, x0, x1, threshold) {
    let dark = 0;
    for (let x = x0; x < x1; x++) if (isDark(imageData.data, width, x, y, threshold)) dark++;
    return dark / (x1 - x0);
  }

  // Rotates a canvas by `angleDeg` around its own center, filling the
  // exposed corners white (matching this document family's real page
  // background — these are never transparent/black-bordered scans).
  function rotateCanvas(canvas, angleDeg) {
    const w = canvas.width, h = canvas.height;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(angleDeg * Math.PI / 180);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(canvas, 0, 0);
    return out;
  }

  // Finds the rotation angle that maximizes a horizontal strip's row-
  // projection-profile sharpness (variance of per-row dark-pixel counts) —
  // real ruled lines/text rows create tall spikes only when properly
  // axis-aligned; a misaligned page smears them out, lowering variance.
  // Verified against real rotated IRD VAT scans: found ~2.1-2.7 degrees on
  // pages with visible skew, ~0 on already-straight ones, and confirmed
  // (via direct OCR comparison against manually-prepared ground truth) that
  // correcting by this angle alone makes structural row-line detection go
  // from finding zero lines to finding a clean, evenly-spaced set.
  function detectSkewAngle(canvas, options) {
    const opts = Object.assign({ stripTop: 0.35, stripBottom: 0.75, range: 6, threshold: 150, maxWidth: 400 }, options);

    // The angle search rotates and rescans the page dozens of times, which is
    // the module's single biggest cost at full render resolution. Skew is a
    // global orientation, unaffected by resolution, so the search runs on a
    // downscaled working copy — verified to return the same angle (to 0.01°)
    // as the full-resolution search while being roughly an order of magnitude
    // faster. The actual extraction still deskews the full-resolution canvas.
    let work = canvas;
    if (canvas.width > opts.maxWidth) {
      const s = opts.maxWidth / canvas.width;
      work = document.createElement('canvas');
      work.width = Math.round(canvas.width * s);
      work.height = Math.round(canvas.height * s);
      work.getContext('2d').drawImage(canvas, 0, 0, work.width, work.height);
    }
    const w = work.width, h = work.height;
    const y0 = Math.round(h * opts.stripTop), y1 = Math.round(h * opts.stripBottom);
    const stripH = y1 - y0;

    function sharpnessAt(angle) {
      const rotated = rotateCanvas(work, angle);
      const imgData = rotated.getContext('2d').getImageData(0, y0, w, stripH);
      const rowSums = new Float64Array(stripH);
      for (let y = 0; y < stripH; y++) {
        let s = 0;
        for (let x = 0; x < w; x++) if (isDark(imgData.data, w, x, y, opts.threshold)) s++;
        rowSums[y] = s;
      }
      let mean = 0; for (let i = 0; i < stripH; i++) mean += rowSums[i]; mean /= stripH;
      let variance = 0; for (let i = 0; i < stripH; i++) variance += (rowSums[i] - mean) ** 2;
      return variance / stripH;
    }

    // Coarse-to-fine search: a wide coarse sweep, then two refinements around
    // the running best. Reaches 0.03° resolution in far fewer rotations than
    // one fine sweep would (the projection-sharpness peak is unimodal within
    // this angle range, so the coarse step won't skip past it).
    let center = 0;
    for (const [half, step] of [[opts.range, 0.6], [0.8, 0.12], [0.15, 0.03]]) {
      let best = { angle: center, score: -Infinity };
      for (let a = center - half; a <= center + half + 1e-9; a += step) {
        const s = sharpnessAt(a);
        if (s > best.score) best = { angle: a, score: s };
      }
      center = best.angle;
    }
    return center;
  }

  // Detects long, high-density horizontal rule lines within a region
  // (fractions of the full canvas) — the same dark-pixel-density row-scan
  // idea already proven elsewhere in this app for finding one line,
  // generalized to find every line in a region. Returns line *center*
  // y-positions as fractions of canvas height, in top-to-bottom order.
  function detectHorizontalLines(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.round(region.left * w), x1 = Math.round(region.right * w);
    const yFrom = Math.round(region.top * h), yTo = Math.round(region.bottom * h);
    const threshold = region.densityThreshold || 0.55;
    const imageData = canvas.getContext('2d').getImageData(0, yFrom, w, yTo - yFrom);
    const lines = [];
    let inLine = false, lineStart = 0;
    for (let y = 0; y < yTo - yFrom; y++) {
      const isLine = rowDarkFraction(imageData, w, y, x0, x1, 150) > threshold;
      if (isLine) { if (!inLine) { inLine = true; lineStart = y; } }
      else if (inLine) { inLine = false; lines.push((yFrom + Math.round((lineStart + y - 1) / 2)) / h); }
    }
    return lines;
  }

  // Some genuine row boundaries in a real form print a consistently
  // fainter rule than the rest (confirmed on both a clean and a rotated
  // real IRD VAT scan — the same gap appeared in the same place on both,
  // so it's a form-printing trait, not a rotation artifact) and fall below
  // the density threshold. A gap roughly double the median spacing gets one
  // interpolated line inserted at its midpoint, so the detected set matches
  // the reference set's structure more completely for alignment.
  function repairLineGaps(lines) {
    if (lines.length < 3) return lines.slice();
    const gaps = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1]);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const out = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i] - lines[i - 1];
      if (gap > median * 1.6 && gap < median * 2.4) out.push((lines[i - 1] + lines[i]) / 2);
      out.push(lines[i]);
    }
    return out;
  }

  // Least-squares fit of a 1-D affine map y = a·x + b from paired samples
  // (ref[i] -> target[i]). Used to align a reference set of structural
  // positions (e.g. a form's table rule lines) onto the same structure
  // detected on another scan, capturing both a vertical shift (different
  // margin) and a scale (different DPI/crop) in one transform — so already-
  // calibrated field boxes can be carried onto a new scan without any
  // per-field re-measurement. Returns null if the inputs can't define a
  // line (fewer than 2 points, or all ref values identical).
  function fitLinearMap(ref, target) {
    const n = Math.min(ref.length, target.length);
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += ref[i]; sy += target[i];
      sxx += ref[i] * ref[i]; sxy += ref[i] * target[i];
    }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-12) return null;
    const a = (n * sxy - sx * sy) / denom;
    const b = (sy - a * sx) / n;
    return { a, b };
  }

  // Counts how many `target` positions land within `tol` of some `a·ref+b`.
  function countInliers(ref, target, a, b, tol) {
    let count = 0;
    for (const t of target) {
      for (const r of ref) { if (Math.abs(t - (a * r + b)) <= tol) { count++; break; } }
    }
    return count;
  }

  // Robustly aligns a detected set of structural positions (`target`) onto a
  // known reference set (`ref`), returning the affine map ref -> target (so
  // reference-calibrated coordinates can be carried onto a new scan), or null
  // if no confident alignment exists. It must survive the real failure modes
  // seen on scanned IRD VAT forms: the detector missing a faint rule line,
  // catching a spurious dark row, or being off-by-one against the reference
  // sequence — any of which breaks naive index or nearest-neighbour matching.
  // So it is RANSAC-style: it hypothesises the map from well-separated anchor
  // pairs (endpoints of each set, which give the most stable scale estimate),
  // scores each hypothesis by how many target lines it explains, keeps the
  // best, and refits offset+scale on that inlier set. `minInliers` guards
  // against accepting a map supported by only a couple of coincidental
  // matches — below it, the caller falls back to fixed coordinates.
  function alignLinear(ref, target, tol, minInliers) {
    if (ref.length < 2 || target.length < 2) return null;
    const need = minInliers || 5;
    const tAnchors = [[0, target.length - 1], [1, target.length - 1], [0, target.length - 2], [1, target.length - 2]]
      .filter(([p, q]) => p < q && p >= 0 && q < target.length);
    let best = null, bestCount = -1;
    for (const [p, q] of tAnchors) {
      for (let j1 = 0; j1 < ref.length - 1; j1++) {
        for (let j2 = j1 + 1; j2 < ref.length; j2++) {
          const a = (target[q] - target[p]) / (ref[j2] - ref[j1]);
          if (a < 0.8 || a > 1.25) continue;
          const b = target[p] - a * ref[j1];
          const count = countInliers(ref, target, a, b, tol);
          if (count > bestCount) { bestCount = count; best = { a, b }; }
        }
      }
    }
    if (!best || bestCount < need) return null;
    const inRef = [], inTgt = [];
    for (const t of target) {
      let nearest = null, nd = Infinity;
      for (const r of ref) { const d = Math.abs(t - (best.a * r + best.b)); if (d < nd) { nd = d; nearest = r; } }
      if (nd <= tol) { inRef.push(nearest); inTgt.push(t); }
    }
    return fitLinearMap(inRef, inTgt) || best;
  }

  return { rotateCanvas, detectSkewAngle, detectHorizontalLines, repairLineGaps, fitLinearMap, alignLinear };
})();

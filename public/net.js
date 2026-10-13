/* Zerlegt das Strassennetz (network.json) in Abschnitte von etwa 40 m.
   Wird vom Server und von der Karte benutzt, damit beide dieselben Abschnittsnummern sehen. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NetBuild = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function build(NET, CHUNK) {
    CHUNK = CHUNK || 40;
    var chunkOff = [0], chunkPts = [], chunkLen = [];
    var totalChunks = 0, totalLen = 0;
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    NET.nodes.forEach(function (n) {
      x0 = Math.min(x0, n[0]); x1 = Math.max(x1, n[0]);
      y0 = Math.min(y0, n[1]); y1 = Math.max(y1, n[1]);
    });

    NET.edges.forEach(function (d) {
      var pts = d[2], m = pts.length / 2, cum = [0], j;
      for (j = 1; j < m; j++) {
        cum.push(cum[j - 1] + Math.hypot(pts[2 * j] - pts[2 * j - 2], pts[2 * j + 1] - pts[2 * j - 1]));
      }
      var len = cum[m - 1];
      var n = Math.max(1, Math.round(len / CHUNK));
      var cl = len / n;
      function at(t) {
        var i = 1;
        while (i < m - 1 && cum[i] < t) i++;
        var seg = cum[i] - cum[i - 1], f = seg > 0 ? (t - cum[i - 1]) / seg : 0;
        return [pts[2 * i - 2] + (pts[2 * i] - pts[2 * i - 2]) * f,
                pts[2 * i - 1] + (pts[2 * i + 1] - pts[2 * i - 1]) * f];
      }
      for (var k = 0; k < n; k++) {
        var t0 = k * cl, t1 = (k + 1) * cl, p0 = at(t0), p1 = at(t1);
        chunkPts.push(p0[0], p0[1]);
        for (var q = 1; q < m - 1; q++) {
          if (cum[q] > t0 + 0.5 && cum[q] < t1 - 0.5) chunkPts.push(pts[2 * q], pts[2 * q + 1]);
        }
        chunkPts.push(p1[0], p1[1]);
        chunkOff.push(chunkPts.length);
        chunkLen.push(cl);
      }
      totalChunks += n; totalLen += len;
    });

    return {
      chunkOff: chunkOff,
      chunkPts: chunkPts,
      chunkLen: chunkLen,
      totalChunks: totalChunks,
      totalLen: totalLen,
      bounds: { x0: x0, x1: x1, y0: y0, y1: y1 }
    };
  }
  return { build: build };
}));

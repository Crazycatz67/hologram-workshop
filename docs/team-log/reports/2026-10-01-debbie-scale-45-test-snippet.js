  group('Two-hand scale starts with everything armed (BUGS #45)', () => {
    // Owner live bug 2026-10-01 ("Everything on" drill): raising two open hands is explode's
    // pose, so explode engaged; pinching then ended it, and its neutral gap waited for a
    // neutral moment a held pinch never gives -- scale never started (0 of 76 pinching frames).
    const FR = 1000 / 30;
    const drive = (m, n, specs, t, seen) => {
      for (let i = 0; i < n; i++) {
        const mode = m.update(specs(i).map(([x, y, kind]) => hand(x, y, 0, kind)), 1.78, t);
        seen?.add(mode);
        t += FR;
      }
      return t;
    };
    const fresh = () => {
      object.position.set(0, 0, 0);
      object.quaternion.identity();
      object.scale.set(1, 1, 1);
      const m = createManipulator(object, camera);
      m.reset();
      m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
      return m;
    };
    // Open hands up (explode engages), then both pinch and pull apart.
    let m = fresh();
    let t = 1000;
    let seen = new Set();
    t = drive(m, 12, () => [[0.4, 0.5, 'open'], [0.6, 0.5, 'open']], t, seen);
    checkTrue('open hands raised first engage explode (the trigger)', seen.has(MODE.EXPLODE), [...seen].join(','));
    seen = new Set();
    t = drive(m, 15, () => [[0.4, 0.5, 'pinch'], [0.6, 0.5, 'pinch']], t, seen);
    checkTrue('#45: pinching after open hands reaches transform within 0.5 s', seen.has(MODE.TRANSFORM), [...seen].join(','));
    const s0 = object.scale.x;
    t = drive(m, 20, (i) => [[0.4 - 0.01 * i, 0.5, 'pinch'], [0.6 + 0.01 * i, 0.5, 'pinch']], t);
    checkTrue('#45: ... and pulling apart grows the model', object.scale.x > s0 + 0.1, `scale ${fmt(s0)} -> ${fmt(object.scale.x)}`);

    // #26 still holds: releasing the pinch into open hands does not chain into explode.
    seen = new Set();
    t = drive(m, 30, () => [[0.4, 0.5, 'open'], [0.6, 0.5, 'open']], t, seen);
    checkTrue('#26 kept: releasing the pinch into open hands does not explode', !seen.has(MODE.EXPLODE), [...seen].join(','));
  });

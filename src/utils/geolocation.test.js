import test from 'node:test';
import assert from 'node:assert/strict';

import { getCurrentLocation, MAX_GPS_ACCURACY_FOR_CHECKIN } from './geolocation.js';

const PADANG = { lat: -0.9546883, lng: 100.3643174 };

const position = (accuracy, offset = 0) => ({
  coords: {
    latitude: PADANG.lat + offset,
    longitude: PADANG.lng,
    accuracy,
  },
});

// Mirrors the scope injection used by gpsSignalTrace: the module reads
// navigator, setTimeout and clearTimeout off the scope it is handed.
const harness = ({ samples = [], watchError = null, lowAccuracy = null,
  lowError = null, noWatch = false } = {}) => {
  const state = { cleared: 0, watchOptions: null, lowOptions: null, timers: 0 };
  const geolocation = {
    getCurrentPosition: (onPosition, onError, options) => {
      state.lowOptions = options;
      setTimeout(() => {
        if (lowError) onError(lowError);
        else if (lowAccuracy != null) onPosition(position(lowAccuracy));
        else onError({ code: 2 });
      }, 0);
    },
    clearWatch: () => {
      state.cleared += 1;
    },
  };
  if (!noWatch) {
    geolocation.watchPosition = (onPosition, onError, options) => {
      state.watchOptions = options;
      // Errors are delivered after the samples so a test can choose whether
      // the watch is holding anything when the error lands.
      if (watchError) setTimeout(() => onError(watchError), samples.length);
      samples.forEach((accuracy, index) => {
        setTimeout(() => onPosition(position(accuracy, index * 1e-5)), index);
      });
      return 7;
    };
  }
  const scope = {
    navigator: { geolocation },
    setTimeout: (fn, ms) => {
      state.timers += 1;
      return setTimeout(fn, ms);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  return { scope, state };
};

test('resolves on the first fix that is accurate enough, without waiting out the budget', async () => {
  const { scope, state } = harness({ samples: [12] });
  const started = Date.now();
  const location = await getCurrentLocation({ scope, convergenceBudgetMs: 5000 });
  assert.equal(location.accuracy, 12);
  assert.equal(location.source, 'gps-high');
  assert.ok(Date.now() - started < 1000, 'tidak boleh menunggu seluruh budget');
  assert.equal(state.cleared, 1, 'watch harus dibersihkan');
});

test('waits for a coarse first sample to converge instead of rejecting it', async () => {
  // This is the case the single-shot implementation failed: the platform
  // answers immediately with a network fix, then GPS settles a moment later.
  const { scope } = harness({ samples: [820, 240, 18] });
  const location = await getCurrentLocation({ scope, convergenceBudgetMs: 5000 });
  assert.equal(location.accuracy, 18);
});

test('keeps the best sample seen when nothing reaches the threshold', async () => {
  const { scope } = harness({ samples: [900, 260, 410], lowAccuracy: 80 });
  const location = await getCurrentLocation({ scope, convergenceBudgetMs: 60 });
  // Budget expires holding 260m; the low-accuracy shot is better, so it wins.
  assert.equal(location.accuracy, 80);
  assert.equal(location.source, 'gps-low');
});

test('a fix that stays coarse is still refused, exactly as before', async () => {
  const { scope } = harness({ samples: [900, 260], lowAccuracy: 300 });
  await assert.rejects(
    getCurrentLocation({ scope, convergenceBudgetMs: 60 }),
    (error) => error.code === 'GPS_UNAVAILABLE'
  );
});

test('a denied permission fails immediately rather than burning the budget', async () => {
  const { scope, state } = harness({ watchError: { code: 1 }, lowError: { code: 1 } });
  const started = Date.now();
  await assert.rejects(
    getCurrentLocation({ scope, convergenceBudgetMs: 30000 }),
    (error) => error.code === 'GPS_DENIED'
  );
  assert.ok(Date.now() - started < 1000, 'tidak boleh menunggu budget habis');
  assert.equal(state.cleared, 1);
});

test('a transient watch error does not discard a sample already held', async () => {
  // The watch is holding a coarse fix when the error lands: giving up there
  // would throw away a reading the low-accuracy pass can still improve on.
  const { scope } = harness({
    samples: [300],
    watchError: { code: 2 },
    lowAccuracy: 25,
  });
  const location = await getCurrentLocation({ scope, convergenceBudgetMs: 60 });
  assert.equal(location.accuracy, 25);
});

test('an empty budget with no sample reports a timeout', async () => {
  const { scope } = harness({ samples: [], lowError: { code: 3 } });
  await assert.rejects(
    getCurrentLocation({ scope, convergenceBudgetMs: 30 }),
    (error) => error.code === 'GPS_TIMEOUT'
  );
});

test('falls back to a single shot where watchPosition is unavailable', async () => {
  const { scope, state } = harness({ noWatch: true, lowAccuracy: 20 });
  const location = await getCurrentLocation({ scope, convergenceBudgetMs: 5000 });
  assert.equal(location.accuracy, 20);
  assert.equal(state.cleared, 0);
});

test('the watch asks for high accuracy and refuses cached positions', async () => {
  const { scope, state } = harness({ samples: [10] });
  await getCurrentLocation({ scope, convergenceBudgetMs: 5000 });
  assert.equal(state.watchOptions.enableHighAccuracy, true);
  assert.equal(state.watchOptions.maximumAge, 0);
});

test('the accepted accuracy ceiling still matches the backend contract', () => {
  assert.equal(MAX_GPS_ACCURACY_FOR_CHECKIN, 100);
});

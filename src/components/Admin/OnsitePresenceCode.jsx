import { useEffect, useMemo, useRef, useState } from 'react';
import {
  loadOnsitePresenceGeofences,
  loadOnsitePresenceEmployees,
  requestOnsitePresenceCode,
} from '../../services/presenceCodeService';

const WIB_TIME_FORMATTER = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function groupByType(geofences, type) {
  return geofences.filter((geofence) => geofence.type === type);
}

function OnsitePresenceCode() {
  const [geofences, setGeofences] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listRevision, setListRevision] = useState(0);
  const [codeResult, setCodeResult] = useState(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeRefreshing, setCodeRefreshing] = useState(false);
  const [codeError, setCodeError] = useState('');
  const [codeRevision, setCodeRevision] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const requestGenerationRef = useRef(0);

  const selectedGeofence = useMemo(
    () => geofences.find((geofence) => geofence.key === selectedKey) || null,
    [geofences, selectedKey]
  );
  const eligibleEmployees = useMemo(
    () => employees.filter((employee) => employee.geofenceKey === selectedKey),
    [employees, selectedKey]
  );
  const selectedEmployee = useMemo(
    () => eligibleEmployees.find((employee) => employee.id === selectedEmployeeId) || null,
    [eligibleEmployees, selectedEmployeeId]
  );

  useEffect(() => {
    let disposed = false;

    async function loadGeofences() {
      setListLoading(true);
      setListError('');
      try {
        const [result, employeeResult] = await Promise.all([
          loadOnsitePresenceGeofences(),
          loadOnsitePresenceEmployees(),
        ]);
        if (disposed) return;
        setGeofences(result);
        setEmployees(employeeResult);
        setSelectedKey((currentKey) => {
          const current = result.find((geofence) => geofence.key === currentKey);
          return current?.eligible ? currentKey : '';
        });
      } catch (error) {
        if (disposed) return;
        setGeofences([]);
        setEmployees([]);
        setSelectedKey('');
        setSelectedEmployeeId('');
        setListError(error.message);
      } finally {
        if (!disposed) setListLoading(false);
      }
    }

    loadGeofences();
    return () => {
      disposed = true;
    };
  }, [listRevision]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    let disposed = false;
    let refreshTimeoutId;
    const requestGeneration = ++requestGenerationRef.current;

    if (!selectedGeofence?.eligible || !selectedEmployee) {
      return undefined;
    }

    async function fetchCode(backgroundRefresh) {
      if (disposed || requestGeneration !== requestGenerationRef.current) return;
      if (backgroundRefresh) {
        setCodeRefreshing(true);
      } else {
        setCodeLoading(true);
      }
      setCodeError('');

      try {
        const result = await requestOnsitePresenceCode(
          selectedGeofence.type,
          selectedGeofence.id,
          selectedEmployee.id
        );
        if (disposed || requestGeneration !== requestGenerationRef.current) return;

        setCodeResult({
          ...result,
          selectionKey: `${selectedGeofence.key}:${selectedEmployee.id}`,
        });
        const refreshDelay = Math.max(500, result.expiresAtMs - Date.now() + 150);
        refreshTimeoutId = window.setTimeout(() => fetchCode(true), refreshDelay);
      } catch (error) {
        if (disposed || requestGeneration !== requestGenerationRef.current) return;
        setCodeResult(null);
        setCodeError(error.message);
        if (error.retryable) {
          refreshTimeoutId = window.setTimeout(() => fetchCode(true), 10_000);
        }
      } finally {
        if (!disposed && requestGeneration === requestGenerationRef.current) {
          setCodeLoading(false);
          setCodeRefreshing(false);
        }
      }
    }

    setCodeResult(null);
    setCodeError('');
    fetchCode(false);

    return () => {
      disposed = true;
      if (refreshTimeoutId) window.clearTimeout(refreshTimeoutId);
    };
  }, [selectedGeofence, selectedEmployee, codeRevision]);

  const currentSelectionKey = selectedEmployee
    ? `${selectedKey}:${selectedEmployee.id}`
    : '';
  const visibleCodeResult = codeResult?.selectionKey === currentSelectionKey
    ? codeResult
    : null;
  const secondsRemaining = visibleCodeResult
    ? Math.max(0, Math.ceil((visibleCodeResult.expiresAtMs - nowMs) / 1000))
    : 0;
  const codeIsCurrent = Boolean(visibleCodeResult && secondsRemaining > 0);
  const countdownPercent = visibleCodeResult
    ? Math.min(100, Math.max(0, (secondsRemaining / visibleCodeResult.periodSeconds) * 100))
    : 0;
  const eligibleCount = geofences.filter((geofence) => geofence.eligible).length;
  const kelurahan = groupByType(geofences, 'kelurahan');
  const kantor = groupByType(geofences, 'kantor');

  const clearDisplayedCode = () => {
    requestGenerationRef.current += 1;
    setCodeResult(null);
    setCodeError('');
    setCodeLoading(false);
    setCodeRefreshing(false);
  };

  const selectGeofence = (event) => {
    const nextKey = event.target.value;
    if (!nextKey) {
      clearDisplayedCode();
      setSelectedKey('');
      return;
    }
    const nextGeofence = geofences.find((geofence) => geofence.key === nextKey);
    if (!nextGeofence?.eligible) return;
    // Never render a code issued for the previously selected geofence under
    // the new geofence label, even for a single React render.
    clearDisplayedCode();
    setSelectedEmployeeId('');
    setSelectedKey(nextKey);
  };

  const selectEmployee = (event) => {
    clearDisplayedCode();
    setSelectedEmployeeId(event.target.value);
  };

  const reloadGeofences = () => {
    // Revalidation may discover that an active geofence was just disabled.
    // Hide its code while the authoritative configuration is being reloaded.
    clearDisplayedCode();
    setSelectedKey('');
    setSelectedEmployeeId('');
    setListRevision((revision) => revision + 1);
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Kode Kehadiran Onsite</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Pilih karyawan yang sedang melakukan absensi. Setiap kode hanya berlaku untuk
            satu challenge karyawan. Server juga memeriksa GPS perangkat admin sebelum
            menerbitkan kode.
          </p>
        </div>
        <button
          type="button"
          onClick={reloadGeofences}
          disabled={listLoading}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {listLoading ? 'Memuat lokasi...' : 'Muat ulang lokasi'}
        </button>
      </div>

      {selectedGeofence && (
        <div className="mt-4">
          <label htmlFor="onsite-employee" className="mb-2 block text-sm font-semibold text-slate-800">
            Karyawan yang hadir di depan petugas
          </label>
          <select
            id="onsite-employee"
            value={selectedEmployeeId}
            onChange={selectEmployee}
            disabled={eligibleEmployees.length === 0}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">Pilih karyawan setelah ia memulai absensi</option>
            {eligibleEmployees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}{employee.email ? ` — ${employee.email}` : ''}
              </option>
            ))}
          </select>
          {eligibleEmployees.length === 0 && (
            <p className="mt-2 text-xs text-amber-700">
              Tidak ada karyawan aktif dengan penugasan canonical pada lokasi ini.
            </p>
          )}
        </div>
      )}

      <div className="mt-5">
        <label htmlFor="onsite-geofence" className="mb-2 block text-sm font-semibold text-slate-800">
          Lokasi yang dijaga admin
        </label>
        <select
          id="onsite-geofence"
          value={selectedKey}
          onChange={selectGeofence}
          disabled={listLoading || eligibleCount === 0}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:bg-slate-100"
        >
          <option value="">Pilih kelurahan atau kantor</option>
          {kelurahan.length > 0 && (
            <optgroup label="Kelurahan">
              {kelurahan.map((geofence) => (
                <option key={geofence.key} value={geofence.key} disabled={!geofence.eligible}>
                  {geofence.name} — {geofence.status}
                </option>
              ))}
            </optgroup>
          )}
          {kantor.length > 0 && (
            <optgroup label="Kantor">
              {kantor.map((geofence) => (
                <option key={geofence.key} value={geofence.key} disabled={!geofence.eligible}>
                  {geofence.name} — {geofence.status}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {!listLoading && !listError && (
          <p className="mt-2 text-xs text-slate-500">
            {eligibleCount} dari {geofences.length} lokasi siap. Lokasi nonaktif, belum
            terverifikasi, atau belum mewajibkan kode tidak dapat dipilih.
          </p>
        )}
      </div>

      {listError && (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {listError}
        </div>
      )}

      {!listLoading && !listError && eligibleCount === 0 && (
        <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Tidak ada geofence yang aktif, terverifikasi, dan mewajibkan kode onsite.
        </div>
      )}

      {selectedGeofence && selectedEmployee && (
        <div className="mt-6 overflow-hidden rounded-xl border border-blue-200 bg-blue-50">
          <div className="border-b border-blue-200 px-4 py-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
              {selectedGeofence.type === 'kantor' ? 'Kantor' : 'Kelurahan'}
            </p>
            <p className="mt-1 font-semibold text-slate-900">{selectedGeofence.name}</p>
            <p className="mt-1 text-sm text-slate-700">
              {selectedEmployee.name} · {visibleCodeResult?.action === 'checkOut' ? 'Check-out' : 'Check-in'}
            </p>
          </div>

          <div className="px-4 py-7 text-center sm:px-8">
            {codeLoading && !visibleCodeResult && (
              <p role="status" className="py-8 text-sm font-medium text-slate-600">
                Memverifikasi lokasi admin dan meminta kode dari server...
              </p>
            )}

            {codeError && (
              <div role="alert" className="rounded-lg border border-red-200 bg-white p-4 text-sm text-red-700">
                <p>{codeError}</p>
                <button
                  type="button"
                  onClick={() => setCodeRevision((revision) => revision + 1)}
                  className="mt-3 rounded-lg bg-red-700 px-4 py-2 font-semibold text-white hover:bg-red-800"
                >
                  Coba lagi
                </button>
              </div>
            )}

            {visibleCodeResult && (
              <>
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                  Kode aktif
                </p>
                <p
                  aria-live="polite"
                  className="mt-3 font-mono text-5xl font-black tracking-[0.22em] text-slate-950 sm:text-7xl"
                >
                  {codeIsCurrent ? `${visibleCodeResult.code.slice(0, 3)} ${visibleCodeResult.code.slice(3)}` : '--- ---'}
                </p>
                <p className="mt-4 text-sm font-semibold text-blue-800">
                  {codeIsCurrent
                    ? `Berlaku ${secondsRemaining} detik lagi`
                    : 'Kode kedaluwarsa — sedang memperbarui'}
                </p>
                <div className="mx-auto mt-3 h-2 max-w-md overflow-hidden rounded-full bg-blue-100">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-[width] duration-200"
                    style={{ width: `${countdownPercent}%` }}
                  />
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Kedaluwarsa pukul {WIB_TIME_FORMATTER.format(new Date(visibleCodeResult.expiresAtMs))} WIB
                  {codeRefreshing ? ' · Memperbarui...' : ' · Diperbarui otomatis'}
                </p>
                <p className="mt-2 text-xs font-medium text-emerald-700">
                  GPS admin diverifikasi server: {Math.round(visibleCodeResult.verifier.distanceMeters)}m
                  {' '}dari pusat lokasi · akurasi {Math.round(visibleCodeResult.verifier.accuracyMeters)}m
                </p>
              </>
            )}
          </div>
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Cocokkan identitas karyawan secara langsung. Kode terikat pada challenge yang sedang
        aktif, hanya dapat dipakai sekali, hanya diterbitkan saat perangkat admin berada di
        geofence, dan tidak boleh dikirim melalui chat.
      </p>
    </section>
  );
}

export default OnsitePresenceCode;

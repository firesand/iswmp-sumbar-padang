import { useEffect, useMemo, useState } from 'react';
import {
  captureGeofenceVerificationLocation,
  loadGeofenceVerificationTargets,
  loadPendingGeofenceVerificationProposals,
  proposeGeofenceVerification,
  reviewGeofenceVerification,
} from '../../services/geofenceVerificationService';

const WIB_DATE_TIME = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function coordinateInputValue(value) {
  return Number.isFinite(value) ? String(value) : '';
}

function coordinateLabel(value) {
  return Number.isFinite(value) ? value.toFixed(6) : '-';
}

function GeofenceVerificationPanel({ readOnly = false }) {
  const [targets, setTargets] = useState([]);
  const [pendingProposals, setPendingProposals] = useState([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [form, setForm] = useState({ lat: '', lng: '', radius: '' });
  const [centerEvidence, setCenterEvidence] = useState(null);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [proposalsLoading, setProposalsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState('');
  const [proposalsError, setProposalsError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [capturingCenter, setCapturingCenter] = useState(false);
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [reviewingProposalId, setReviewingProposalId] = useState('');
  const [revision, setRevision] = useState(0);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.key === selectedKey) || null,
    [selectedKey, targets]
  );
  const targetsByKey = useMemo(
    () => new Map(targets.map((target) => [target.key, target])),
    [targets]
  );
  const pendingTargetKeys = useMemo(
    () => new Set(
      pendingProposals
        .filter((proposal) => proposal.valid)
        .map((proposal) => `${proposal.collection}/${proposal.geofenceId}`)
    ),
    [pendingProposals]
  );
  const selectedHasPendingProposal = pendingTargetKeys.has(selectedKey);

  useEffect(() => {
    let disposed = false;
    setTargetsLoading(true);
    setTargetsError('');

    loadGeofenceVerificationTargets()
      .then((result) => {
        if (disposed) return;
        setTargets(result);
        setSelectedKey((current) =>
          result.some((target) => target.key === current) ? current : ''
        );
      })
      .catch((error) => {
        if (disposed) return;
        setTargets([]);
        setSelectedKey('');
        setTargetsError(error.message);
      })
      .finally(() => {
        if (!disposed) setTargetsLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [revision]);

  useEffect(() => {
    let disposed = false;
    setProposalsLoading(true);
    setProposalsError('');

    loadPendingGeofenceVerificationProposals()
      .then((result) => {
        if (!disposed) setPendingProposals(result);
      })
      .catch((error) => {
        if (disposed) return;
        setPendingProposals([]);
        setProposalsError(error.message);
      })
      .finally(() => {
        if (!disposed) setProposalsLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [revision]);

  const selectTarget = (event) => {
    const nextKey = event.target.value;
    const nextTarget = targets.find((target) => target.key === nextKey);
    setSelectedKey(nextKey);
    setCenterEvidence(null);
    setFormError('');
    setNotice('');
    setForm({
      lat: coordinateInputValue(nextTarget?.lat),
      lng: coordinateInputValue(nextTarget?.lng),
      radius: coordinateInputValue(nextTarget?.radius),
    });
  };

  const updateForm = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setCenterEvidence(null);
    setFormError('');
    setNotice('');
  };

  const captureCenter = async () => {
    setCapturingCenter(true);
    setFormError('');
    setNotice('');
    try {
      const location = await captureGeofenceVerificationLocation();
      setForm((current) => ({
        ...current,
        lat: location.lat.toFixed(7),
        lng: location.lng.toFixed(7),
        radius: current.radius || '100',
      }));
      setCenterEvidence({
        accuracy: location.accuracy,
      });
    } catch (error) {
      setCenterEvidence(null);
      setFormError(error.message);
    } finally {
      setCapturingCenter(false);
    }
  };

  const submitProposal = async (event) => {
    event.preventDefault();
    if (!selectedTarget || selectedHasPendingProposal) return;

    setSubmittingProposal(true);
    setFormError('');
    setNotice('');
    try {
      await proposeGeofenceVerification({
        collection: selectedTarget.collection,
        geofenceId: selectedTarget.id,
        lat: form.lat,
        lng: form.lng,
        radius: form.radius,
      });
      setNotice(
        'Proposal tersimpan sebagai pending. Geofence belum aktif dan harus direview akun admin kedua.'
      );
      setCenterEvidence(null);
      setRevision((current) => current + 1);
    } catch (error) {
      setFormError(error.message);
    } finally {
      setSubmittingProposal(false);
    }
  };

  const reviewProposal = async (proposal, decision) => {
    if (!proposal.valid || reviewingProposalId) return;
    const actionLabel = decision === 'approve' ? 'menyetujui' : 'menolak';
    const warning = decision === 'approve'
      ? 'Persetujuan akan mengaktifkan geofence secara server-authoritative. Pastikan Anda reviewer kedua dan sedang berada di lokasi yang benar.'
      : 'Penolakan akan menutup proposal ini. Pastikan data survei memang tidak dapat disetujui.';
    if (!window.confirm(`Anda akan ${actionLabel} proposal ini.\n\n${warning}`)) {
      return;
    }

    setReviewingProposalId(proposal.proposalId);
    setProposalsError('');
    setNotice('');
    try {
      await reviewGeofenceVerification(proposal.proposalId, decision);
      setNotice(
        decision === 'approve'
          ? 'Proposal disetujui. Server telah menyelesaikan aktivasi dan audit geofence.'
          : 'Proposal ditolak oleh server.'
      );
      setRevision((current) => current + 1);
    } catch (error) {
      setProposalsError(error.message);
    } finally {
      setReviewingProposalId('');
    }
  };

  const reload = () => {
    setFormError('');
    setProposalsError('');
    setTargetsError('');
    setNotice('');
    setRevision((current) => current + 1);
  };

  return (
    <section className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Verifikasi Geofence Dua Admin</h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
              Admin pertama mengusulkan pusat dan radius dari lokasi fisik. Admin kedua
              yang berbeda harus mereview di lokasi. Browser tidak menulis geofence
              langsung; seluruh perubahan diputuskan callable server.
            </p>
          </div>
          <button
            type="button"
            onClick={reload}
            disabled={targetsLoading || proposalsLoading}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {targetsLoading || proposalsLoading ? 'Memuat...' : 'Muat ulang'}
          </button>
        </div>

        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          GPS web dapat dipalsukan. Workflow dua admin memperkuat audit, tetapi bukan
          jaminan anti-fake-GPS. Verifikasi kondisi fisik tetap wajib.
        </div>

        {notice && (
          <div role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            {notice}
          </div>
        )}

        {targetsError && (
          <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {targetsError}
          </div>
        )}

        <form onSubmit={submitProposal} className="mt-6 space-y-5">
          <div>
            <label htmlFor="verification-geofence" className="mb-2 block text-sm font-semibold text-slate-800">
              Geofence existing
            </label>
            <select
              id="verification-geofence"
              value={selectedKey}
              onChange={selectTarget}
              disabled={targetsLoading || targets.length === 0}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              <option value="">Pilih kelurahan atau kantor</option>
              {['kelurahan', 'kantor'].map((collectionName) => {
                const options = targets.filter((target) => target.collection === collectionName);
                return options.length > 0 ? (
                  <optgroup
                    key={collectionName}
                    label={collectionName === 'kelurahan' ? 'Kelurahan' : 'Kantor'}
                  >
                    {options.map((target) => (
                      <option key={target.key} value={target.key}>
                        {target.name} — {target.isActive ? 'aktif' : target.coordinateStatus}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </div>

          {selectedTarget && (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label htmlFor="verification-lat" className="mb-1 block text-sm font-medium text-slate-700">
                    Latitude pusat
                  </label>
                  <input
                    id="verification-lat"
                    type="number"
                    min="-90"
                    max="90"
                    step="any"
                    required
                    value={form.lat}
                    onChange={updateForm('lat')}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div>
                  <label htmlFor="verification-lng" className="mb-1 block text-sm font-medium text-slate-700">
                    Longitude pusat
                  </label>
                  <input
                    id="verification-lng"
                    type="number"
                    min="-180"
                    max="180"
                    step="any"
                    required
                    value={form.lng}
                    onChange={updateForm('lng')}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
                <div>
                  <label htmlFor="verification-radius" className="mb-1 block text-sm font-medium text-slate-700">
                    Radius (meter)
                  </label>
                  <input
                    id="verification-radius"
                    type="number"
                    min="1"
                    max="500"
                    step="1"
                    required
                    value={form.radius}
                    onChange={updateForm('radius')}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {!readOnly && (
                  <button
                    type="button"
                    onClick={captureCenter}
                    disabled={capturingCenter || submittingProposal}
                    className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-800 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {capturingCenter ? 'Mengambil GPS...' : 'Gunakan GPS saya sebagai pusat'}
                  </button>
                )}
                {centerEvidence && (
                  <p className="text-xs text-emerald-700">
                    GPS baru diperoleh dengan akurasi ±{Math.round(centerEvidence.accuracy)} m.
                    Submit tetap mengambil pembacaan baru untuk bukti server.
                  </p>
                )}
              </div>

              {selectedHasPendingProposal && (
                <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Geofence ini sudah memiliki proposal pending. Review atau tolak proposal
                  tersebut sebelum membuat proposal baru.
                </div>
              )}

              {formError && (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {formError}
                </div>
              )}

              {readOnly ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 font-medium">
                  Mode Pemantau: Pengajuan perubahan koordinat geofence hanya dapat dilakukan oleh Admin Pengelola.
                </div>
              ) : (
                <button
                  type="submit"
                  disabled={
                    submittingProposal
                    || capturingCenter
                    || proposalsLoading
                    || selectedHasPendingProposal
                  }
                  className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {submittingProposal
                    ? 'Memverifikasi GPS dan mengirim...'
                    : 'Kirim proposal untuk review admin kedua'}
                </button>
              )}
            </>
          )}
        </form>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Proposal Menunggu Review</h3>
          <p className="mt-1 text-sm text-slate-600">
            Identitas dan fingerprint pengusul sengaja tidak ditampilkan. Server memastikan
            akun reviewer berbeda dan memvalidasi GPS baru untuk approve maupun reject.
          </p>
        </div>

        {proposalsError && (
          <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {proposalsError}
          </div>
        )}

        {proposalsLoading ? (
          <p role="status" className="mt-5 text-sm text-slate-500">Memuat proposal pending...</p>
        ) : pendingProposals.length === 0 && !proposalsError ? (
          <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
            Tidak ada proposal geofence yang menunggu review.
          </p>
        ) : (
          <div className="mt-5 grid gap-4">
            {pendingProposals.map((proposal) => {
              const target = proposal.valid
                ? targetsByKey.get(`${proposal.collection}/${proposal.geofenceId}`)
                : null;
              const isProcessing = reviewingProposalId === proposal.proposalId;

              return (
                <article key={proposal.proposalId} className="rounded-xl border border-slate-200 p-4">
                  {!proposal.valid ? (
                    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                      Proposal pending memiliki struktur yang tidak valid. Review diblokir;
                      periksa backend dan audit log privat.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {proposal.collection === 'kantor' ? 'Kantor' : 'Kelurahan'}
                        </p>
                        <h4 className="mt-1 font-semibold text-slate-900">
                          {target?.name || 'Geofence existing'}
                        </h4>
                        <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-sm sm:grid-cols-4">
                          <div>
                            <dt className="text-xs text-slate-500">Latitude</dt>
                            <dd className="font-mono text-slate-800">{coordinateLabel(proposal.lat)}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-slate-500">Longitude</dt>
                            <dd className="font-mono text-slate-800">{coordinateLabel(proposal.lng)}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-slate-500">Radius</dt>
                            <dd className="text-slate-800">{proposal.radius} m</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-slate-500">Diusulkan</dt>
                            <dd className="text-slate-800">
                              {proposal.createdAtMs
                                ? WIB_DATE_TIME.format(new Date(proposal.createdAtMs))
                                : 'Waktu server belum tersedia'}
                            </dd>
                          </div>
                        </dl>
                      </div>

                      <div className="flex shrink-0 gap-2 items-center">
                        {readOnly ? (
                          <span className="rounded bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-800">
                            Menunggu Review Admin Pengelola
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => reviewProposal(proposal, 'reject')}
                              disabled={Boolean(reviewingProposalId) || proposalsLoading}
                              className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-semibold text-red-800 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {isProcessing ? 'Memproses...' : 'Tolak'}
                            </button>
                            <button
                              type="button"
                              onClick={() => reviewProposal(proposal, 'approve')}
                              disabled={Boolean(reviewingProposalId) || proposalsLoading}
                              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                            >
                              {isProcessing ? 'Memproses...' : 'Setujui'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default GeofenceVerificationPanel;

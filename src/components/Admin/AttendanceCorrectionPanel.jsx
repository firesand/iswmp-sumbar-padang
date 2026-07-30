import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore';

import { auth, db } from '../../config/firebase';
import {
  proposeMissingCheckoutCorrection,
  reviewAttendanceCorrection,
} from '../../services/attendanceCorrectionService';
import { isAttendanceWorkflowEligible } from '../../utils/attendanceIntegrity';
import {
  attachEffectiveAttendanceCorrection,
  resolveAttendanceCompletion,
} from '../../utils/attendanceCorrection';
import {
  formatWibDate,
  formatWibTime,
  getWibDateDaysAgo,
  getWibDateString,
} from '../../utils/attendanceTime';

const CORRECTION_LOOKBACK_DAYS = 7;
const DEFAULT_MAX_SHIFT_MINUTES = 1440;
const SUGGESTED_CHECKOUT_HOUR_WIB = 17;

const wibDateTimeInput = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
};

const parseWibDateTimeInput = (value) => {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}:00.000+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const attendanceTimestampMillis = (value) => {
  if (value == null) return null;
  if (typeof value?.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value?.toDate === 'function') {
    const millis = value.toDate().getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  const millis = value instanceof Date
    ? value.getTime()
    : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
};

const suggestCheckOutAt = (record, now = new Date()) => {
  const checkInMs = attendanceTimestampMillis(record?.checkIn);
  if (!checkInMs || typeof record?.date !== 'string') {
    return wibDateTimeInput(now);
  }

  const maxByPolicy = checkInMs + DEFAULT_MAX_SHIFT_MINUTES * 60_000;
  const suggested = new Date(
    `${record.date}T${String(SUGGESTED_CHECKOUT_HOUR_WIB).padStart(2, '0')}:00:00.000+07:00`
  );
  let targetMs = suggested.getTime();
  if (!Number.isFinite(targetMs) || targetMs <= checkInMs) {
    targetMs = checkInMs + 8 * 3_600_000;
  }
  targetMs = Math.min(targetMs, maxByPolicy, now.getTime());
  if (targetMs <= checkInMs) {
    targetMs = Math.min(checkInMs + 60_000, now.getTime(), maxByPolicy);
  }
  return wibDateTimeInput(new Date(targetMs));
};

const formatCandidateLabel = (record) => {
  const name = record.userName || record.userId || 'Tanpa nama';
  const dateLabel = record.date
    ? formatWibDate(record.date, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
    : '—';
  const checkInLabel = formatWibTime(record.checkIn) || '—';
  return `${name} · ${dateLabel} · masuk ${checkInLabel} WIB`;
};

const attachCorrectionViews = async (records) => {
  const projectionSnapshots = await Promise.all(
    records.map((record) => getDoc(doc(
      db,
      'attendanceCorrectionEffectiveViews',
      record.id
    )))
  );
  return records.map((record, index) =>
    attachEffectiveAttendanceCorrection(
      record,
      projectionSnapshots[index].exists()
        ? projectionSnapshots[index].data()
        : null
    )
  );
};

const isOpenCorrectionCandidate = (record, today = getWibDateString()) =>
  Boolean(
    record?.id &&
    typeof record.date === 'string' &&
    record.date < today &&
    isAttendanceWorkflowEligible(record) &&
    !resolveAttendanceCompletion(record).isComplete
  );

export default function AttendanceCorrectionPanel({
  attendanceRecords = [],
  onChanged,
}) {
  const [selectedAttendanceId, setSelectedAttendanceId] = useState('');
  const [checkOutAt, setCheckOutAt] = useState(wibDateTimeInput());
  const [reason, setReason] = useState('');
  const [proposals, setProposals] = useState([]);
  const [detectedRecords, setDetectedRecords] = useState([]);
  const [detecting, setDetecting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const eligibleRecords = useMemo(() => {
    const today = getWibDateString();
    const byId = new Map();
    [...detectedRecords, ...attendanceRecords].forEach((record) => {
      if (!isOpenCorrectionCandidate(record, today)) return;
      if (!byId.has(record.id)) {
        byId.set(record.id, record);
      }
    });
    return [...byId.values()].sort((left, right) => {
      const nameOrder = String(left.userName || left.userId || '')
        .localeCompare(String(right.userName || right.userId || ''), 'id');
      if (nameOrder !== 0) return nameOrder;
      const checkInOrder =
        (attendanceTimestampMillis(left.checkIn) || 0) -
        (attendanceTimestampMillis(right.checkIn) || 0);
      return checkInOrder || String(left.id).localeCompare(String(right.id));
    });
  }, [attendanceRecords, detectedRecords]);

  const selectedRecord = useMemo(
    () => eligibleRecords.find((record) => record.id === selectedAttendanceId) ||
      null,
    [eligibleRecords, selectedAttendanceId]
  );

  const loadOpenCandidates = useCallback(async () => {
    setDetecting(true);
    try {
      const now = new Date();
      const dates = Array.from(
        { length: CORRECTION_LOOKBACK_DAYS },
        (_, index) => getWibDateDaysAgo(index, now)
      );
      const snapshots = await Promise.all(
        dates.map((date) => getDocs(query(
          collection(db, 'attendances'),
          where('date', '==', date)
        )))
      );
      const records = await attachCorrectionViews(
        snapshots.flatMap((snapshot) =>
          snapshot.docs.map((attendanceDoc) => ({
            id: attendanceDoc.id,
            ...attendanceDoc.data(),
          }))
        )
      );
      setDetectedRecords(
        records.filter((record) => isOpenCorrectionCandidate(record, getWibDateString(now)))
      );
    } catch (error) {
      console.error('Unable to detect open checkout candidates:', error);
      setDetectedRecords([]);
      setMessage(
        'Daftar shift terbuka tidak dapat dimuat. Muat ulang halaman.'
      );
    } finally {
      setDetecting(false);
    }
  }, []);

  const loadProposals = useCallback(async () => {
    const proposalSnapshot = await getDocs(query(
      collection(db, 'attendanceCorrectionProposals'),
      orderBy('proposedAt', 'desc'),
      limit(50)
    ));
    const proposalRows = proposalSnapshot.docs.map((snapshot) => ({
      id: snapshot.id,
      ...snapshot.data(),
    }));
    const decisionSnapshots = await Promise.all(
      proposalRows.map((proposal) =>
        getDoc(doc(db, 'attendanceCorrectionDecisions', proposal.id))
      )
    );
    setProposals(proposalRows.map((proposal, index) => ({
      ...proposal,
      decision: decisionSnapshots[index].exists()
        ? decisionSnapshots[index].data()
        : null,
    })));
  }, []);

  useEffect(() => {
    loadOpenCandidates().catch((error) => {
      console.error('Unable to load open checkout candidates:', error);
    });
    loadProposals().catch((error) => {
      console.error('Unable to load attendance corrections:', error);
      setMessage('Daftar koreksi tidak dapat dimuat.');
    });
  }, [loadOpenCandidates, loadProposals]);

  useEffect(() => {
    if (
      selectedAttendanceId &&
      eligibleRecords.some((record) => record.id === selectedAttendanceId)
    ) {
      return;
    }
    const next = eligibleRecords[0] || null;
    setSelectedAttendanceId(next?.id || '');
    if (next) {
      setCheckOutAt(suggestCheckOutAt(next));
    }
  }, [eligibleRecords, selectedAttendanceId]);

  const handleSelectAttendance = (attendanceId) => {
    setSelectedAttendanceId(attendanceId);
    const record = eligibleRecords.find((item) => item.id === attendanceId);
    if (record) {
      setCheckOutAt(suggestCheckOutAt(record));
    }
  };

  const submitProposal = async (event) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const parsedCheckOut = parseWibDateTimeInput(checkOutAt);
      if (!selectedAttendanceId || !parsedCheckOut) {
        throw new Error('Pilih nama pegawai dan waktu checkout WIB yang valid.');
      }
      const result = await proposeMissingCheckoutCorrection({
        attendanceId: selectedAttendanceId,
        checkOutAt: parsedCheckOut,
        reason,
      });
      setReason('');
      setMessage(
        `Proposal ${result.proposalId} dibuat. Admin kedua wajib mereview.`
      );
      await loadProposals();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const review = async (proposalId, decision) => {
    setLoading(true);
    setMessage('');
    try {
      const result = await reviewAttendanceCorrection(proposalId, decision);
      setMessage(
        decision === 'approve'
          ? 'Koreksi disetujui sebagai checkout administratif non-terverifikasi.'
          : 'Proposal koreksi ditolak.'
      );
      await loadProposals();
      let projection = null;
      if (decision === 'approve') {
        const projectionSnapshot = await getDoc(doc(
          db,
          'attendanceCorrectionEffectiveViews',
          result.attendanceId
        ));
        projection = projectionSnapshot.exists()
          ? projectionSnapshot.data()
          : null;
        setDetectedRecords((records) =>
          records
            .map((record) =>
              record.id === result.attendanceId && projection
                ? attachEffectiveAttendanceCorrection(record, projection)
                : record
            )
            .filter(isOpenCorrectionCandidate)
        );
      }
      await onChanged?.({
        attendanceId: result.attendanceId,
        projection,
      });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mt-6 rounded-xl border border-orange-200 bg-orange-50 p-5">
      <h3 className="text-lg font-semibold text-orange-950">
        Koreksi missing checkout
      </h3>
      <p className="mt-1 text-sm text-orange-900">
        Sistem mendeteksi pegawai yang check-in tetapi belum check-out
        (hingga {CORRECTION_LOOKBACK_DAYS} hari terakhir). Pilih nama dari
        daftar, lalu ajukan koreksi. Hasil selalu berlabel administratif dan
        memerlukan admin kedua.
      </p>

      <form onSubmit={submitProposal} className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium text-gray-800 md:col-span-2">
          Pegawai belum check-out
          <select
            value={selectedAttendanceId}
            onChange={(event) => handleSelectAttendance(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
            disabled={loading || detecting || eligibleRecords.length === 0}
            required
          >
            {detecting && (
              <option value="">Mendeteksi shift terbuka…</option>
            )}
            {!detecting && eligibleRecords.length === 0 && (
              <option value="">Tidak ada shift terbuka terdeteksi</option>
            )}
            {!detecting && eligibleRecords.map((record) => (
              <option key={record.id} value={record.id}>
                {formatCandidateLabel(record)}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs font-normal text-gray-500">
            {detecting
              ? `Memindai absensi ${getWibDateString()} dan ${CORRECTION_LOOKBACK_DAYS - 1} hari sebelumnya…`
              : eligibleRecords.length === 0
                ? 'Semua shift dalam rentang ini sudah selesai atau sudah dikoreksi.'
                : `${eligibleRecords.length} pegawai terdeteksi belum check-out.`}
          </span>
          {selectedRecord && (
            <span className="mt-2 block rounded-lg border border-orange-100 bg-white px-3 py-2 text-xs font-normal text-gray-700">
              Terpilih: <strong>{selectedRecord.userName || selectedRecord.userId}</strong>
              {' · '}tanggal kerja {selectedRecord.date}
              {' · '}ID <code className="break-all">{selectedRecord.id}</code>
            </span>
          )}
        </label>
        <label className="text-sm font-medium text-gray-800">
          Checkout efektif (WIB)
          <input
            type="datetime-local"
            value={checkOutAt}
            onChange={(event) => setCheckOutAt(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
            disabled={loading || !selectedAttendanceId}
          />
          <span className="mt-1 block text-xs font-normal text-gray-500">
            Otomatis diisi ~17:00 WIB hari check-in (dibatasi max 24 jam / tidak
            ke masa depan). Sesuaikan jika perlu.
          </span>
        </label>
        <label className="text-sm font-medium text-gray-800">
          Alasan (10–500 karakter)
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={10}
            maxLength={500}
            rows={3}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
            disabled={loading || !selectedAttendanceId}
            required
            placeholder="Contoh: Lupa check-out; shift expired. Koreksi administratif."
          />
        </label>
        <button
          type="submit"
          disabled={
            loading ||
            detecting ||
            !selectedAttendanceId ||
            reason.trim().length < 10
          }
          className="rounded-lg bg-orange-700 px-4 py-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 md:col-span-2"
        >
          Ajukan koreksi
        </button>
      </form>

      {message && (
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-gray-800">
          {message}
        </p>
      )}

      <div className="mt-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-semibold text-gray-900">Proposal terbaru</h4>
          <button
            type="button"
            onClick={() => {
              loadOpenCandidates().catch(() => {});
              loadProposals().catch(() => {});
            }}
            disabled={loading || detecting}
            className="rounded border border-orange-300 bg-white px-3 py-1.5 text-xs font-semibold text-orange-900 disabled:opacity-40"
          >
            Muat ulang daftar
          </button>
        </div>
        {proposals.length === 0 ? (
          <p className="text-sm text-gray-600">Belum ada proposal.</p>
        ) : proposals.map((proposal) => {
          const finalStatus = proposal.decision?.status || 'pending';
          const selfProposed = proposal.proposerUid === auth.currentUser?.uid;
          const candidate = eligibleRecords.find(
            (record) => record.id === proposal.attendanceId
          );
          return (
            <article key={proposal.id} className="rounded-lg border border-orange-100 bg-white p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-gray-900">
                    {candidate?.userName ||
                      proposal.userName ||
                      proposal.attendanceId}
                  </p>
                  <p className="text-xs text-gray-600">
                    {proposal.workDate || candidate?.date || '—'}
                    {' · '}Checkout {formatWibDate(proposal.requestedCheckOut, {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}, {formatWibTime(proposal.requestedCheckOut)} WIB
                  </p>
                  <p className="mt-1 text-sm text-gray-700">{proposal.reason}</p>
                </div>
                <span className="rounded bg-gray-100 px-2 py-1 text-xs font-semibold uppercase text-gray-700">
                  {finalStatus}
                </span>
              </div>
              {finalStatus === 'pending' && (
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => review(proposal.id, 'approve')}
                    disabled={loading || selfProposed}
                    className="rounded bg-emerald-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    Setujui
                  </button>
                  <button
                    type="button"
                    onClick={() => review(proposal.id, 'reject')}
                    disabled={loading || selfProposed}
                    className="rounded bg-red-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    Tolak
                  </button>
                  {selfProposed && (
                    <span className="self-center text-xs text-orange-800">
                      Harus direview admin kedua.
                    </span>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export {
  formatCandidateLabel,
  parseWibDateTimeInput,
  suggestCheckOutAt,
  wibDateTimeInput,
};

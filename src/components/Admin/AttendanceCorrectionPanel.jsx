import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
} from 'firebase/firestore';

import { auth, db } from '../../config/firebase';
import {
  proposeMissingCheckoutCorrection,
  reviewAttendanceCorrection,
} from '../../services/attendanceCorrectionService';
import { isVerifiedAttendance } from '../../utils/attendanceIntegrity';
import { resolveAttendanceCompletion } from '../../utils/attendanceCorrection';
import { formatWibDate, formatWibTime } from '../../utils/attendanceTime';

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

export default function AttendanceCorrectionPanel({
  attendanceRecords = [],
  onChanged,
}) {
  const [selectedAttendanceId, setSelectedAttendanceId] = useState('');
  const [checkOutAt, setCheckOutAt] = useState(wibDateTimeInput());
  const [reason, setReason] = useState('');
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const eligibleRecords = useMemo(
    () => attendanceRecords.filter((record) =>
      record?.id &&
      isVerifiedAttendance(record) &&
      !resolveAttendanceCompletion(record).isComplete
    ),
    [attendanceRecords]
  );

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
    loadProposals().catch((error) => {
      console.error('Unable to load attendance corrections:', error);
      setMessage('Daftar koreksi tidak dapat dimuat.');
    });
  }, [loadProposals]);

  useEffect(() => {
    if (
      selectedAttendanceId &&
      eligibleRecords.some((record) => record.id === selectedAttendanceId)
    ) {
      return;
    }
    setSelectedAttendanceId(eligibleRecords[0]?.id || '');
  }, [eligibleRecords, selectedAttendanceId]);

  const submitProposal = async (event) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const parsedCheckOut = parseWibDateTimeInput(checkOutAt);
      if (!selectedAttendanceId || !parsedCheckOut) {
        throw new Error('Pilih shift dan waktu checkout WIB yang valid.');
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
        Bukti asli tidak diubah. Hasil koreksi selalu berlabel administratif,
        bukan checkout GPS/selfie terverifikasi, dan memerlukan admin kedua.
      </p>

      <form onSubmit={submitProposal} className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm font-medium text-gray-800">
          Shift terbuka
          <input
            list="attendance-correction-candidates"
            value={selectedAttendanceId}
            onChange={(event) => setSelectedAttendanceId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
            disabled={loading}
            placeholder="uid_YYYY-MM-DD"
          />
          <datalist id="attendance-correction-candidates">
            {eligibleRecords.map((record) => (
              <option key={record.id} value={record.id}>
                {record.userName || record.userId} · {record.date} · masuk{' '}
                {formatWibTime(record.checkIn)}
              </option>
            ))}
          </datalist>
          <span className="mt-1 block text-xs font-normal text-gray-500">
            ID lama dapat diketik manual; backend tetap memverifikasi record dan
            pointer shift aktif.
          </span>
        </label>
        <label className="text-sm font-medium text-gray-800">
          Checkout efektif (WIB)
          <input
            type="datetime-local"
            value={checkOutAt}
            onChange={(event) => setCheckOutAt(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
            disabled={loading}
          />
        </label>
        <label className="text-sm font-medium text-gray-800 md:col-span-2">
          Alasan (10–500 karakter)
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={10}
            maxLength={500}
            rows={3}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
            disabled={loading}
            required
          />
        </label>
        <button
          type="submit"
          disabled={loading || !selectedAttendanceId || reason.trim().length < 10}
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
        <h4 className="font-semibold text-gray-900">Proposal terbaru</h4>
        {proposals.length === 0 ? (
          <p className="text-sm text-gray-600">Belum ada proposal.</p>
        ) : proposals.map((proposal) => {
          const finalStatus = proposal.decision?.status || 'pending';
          const selfProposed = proposal.proposerUid === auth.currentUser?.uid;
          return (
            <article key={proposal.id} className="rounded-lg border border-orange-100 bg-white p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-gray-900">
                    {proposal.attendanceId}
                  </p>
                  <p className="text-xs text-gray-600">
                    Checkout {formatWibDate(proposal.requestedCheckOut, {
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
  parseWibDateTimeInput,
  wibDateTimeInput,
};

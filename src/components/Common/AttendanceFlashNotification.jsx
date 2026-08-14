import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getEmployeeAttendanceState } from '../../services/database';
import {
  ATTENDANCE_TIMEZONE,
  getWibDateString,
} from '../../utils/attendanceTime';
import { isAttendanceWorkflowEligible } from '../../utils/attendanceIntegrity';

/**
 * AttendanceFlashNotification
 * Memantau waktu WIB secara realtime dan menampilkan flash notifikasi jika:
 * 1. Pukul 08.09 WIB (menjelang batas on-time 08.10 WIB) dan karyawan belum Check-In.
 * 2. Pukul 19.00 WIB (atau setelahnya) dan karyawan belum Check-Out shift hari ini.
 */
export default function AttendanceFlashNotification({ user, userData }) {
  const navigate = useNavigate();
  const location = useLocation();

  const [activeAlert, setActiveAlert] = useState(null); // 'checkIn' | 'checkOut' | null
  const [snoozedUntil, setSnoozedUntil] = useState(null);
  const [todayAttendance, setTodayAttendance] = useState(null);
  const [activeAttendance, setActiveAttendance] = useState(null);
  const [wibTimeStr, setWibTimeStr] = useState('');
  const [countdownSeconds, setCountdownSeconds] = useState(null);

  const lastNotifiedDateRef = useRef({ checkIn: null, checkOut: null });
  const checkIntervalRef = useRef(null);

  // Request browser notification permission if not asked
  const requestBrowserNotificationPermission = useCallback(async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch (err) {
        console.warn('Browser notification permission error:', err);
      }
    }
  }, []);

  // Send native browser notification if allowed
  const sendBrowserNotification = useCallback((title, body, tag) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const notif = new Notification(title, {
          body,
          icon: '/favicon.ico',
          tag,
          requireInteraction: true,
        });
        notif.onclick = () => {
          window.focus();
          navigate('/employee');
        };
      } catch (err) {
        console.warn('Failed to send browser notification:', err);
      }
    }

    // Trigger vibration if supported
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate([200, 100, 200, 100, 300]);
      } catch {
        // Ignore vibration errors
      }
    }
  }, [navigate]);

  // Fetch current attendance state for user
  const checkAttendance = useCallback(async () => {
    if (!user || !userData || userData.role === 'admin' || userData.isAdmin === true) {
      return;
    }

    try {
      const state = await getEmployeeAttendanceState(user.uid);
      setTodayAttendance(state.todayAttendance || null);
      setActiveAttendance(state.activeAttendance || null);
    } catch (err) {
      console.warn('Error checking attendance in flash notification:', err);
    }
  }, [user, userData]);

  // Periodic attendance fetch
  useEffect(() => {
    if (user && userData && userData.role !== 'admin' && !userData.isAdmin) {
      checkAttendance();
      const interval = window.setInterval(checkAttendance, 20000); // every 20s
      return () => window.clearInterval(interval);
    }
  }, [user, userData, checkAttendance]);

  // Real-time minute/second clock evaluation
  useEffect(() => {
    const evaluateAlerts = () => {
      if (!user || !userData || userData.role === 'admin' || userData.isAdmin === true) {
        setActiveAlert(null);
        return;
      }

      const now = new Date();
      const todayDate = getWibDateString(now);

      // WIB parts
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: ATTENDANCE_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        hourCycle: 'h23',
      }).formatToParts(now);

      const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
      const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
      const second = Number(parts.find((p) => p.type === 'second')?.value || 0);
      const currentMinutes = hour * 60 + minute;

      setWibTimeStr(
        `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} WIB`
      );

      // Check snooze
      if (snoozedUntil && Date.now() < snoozedUntil) {
        return;
      }

      // 1. EVALUATE CHECK-IN FLASH ALERT (Jam 08.09 WIB - batas on-time 08.10 WIB)
      const hasCheckedInToday = Boolean(
        todayAttendance?.checkIn && isAttendanceWorkflowEligible(todayAttendance)
      );

      // Trigger if hour is 8 and minute is 9 (08:09:00 - 08:09:59 WIB) or between 08:09 and 08:10 WIB without check-in
      const isMorningCheckInTime = (hour === 8 && minute === 9) || (hour === 8 && minute === 10);
      const isAfterMorningDeadlineWithoutCheckIn = currentMinutes >= (8 * 60 + 9) && currentMinutes <= (12 * 60);

      if (!hasCheckedInToday && (isMorningCheckInTime || isAfterMorningDeadlineWithoutCheckIn)) {
        setActiveAlert('checkIn');

        // Calculate seconds left until 08:10:00 WIB
        if (hour === 8 && minute === 9) {
          setCountdownSeconds(60 - second);
        } else {
          setCountdownSeconds(null);
        }

        // Send browser notification once per date
        if (lastNotifiedDateRef.current.checkIn !== todayDate && hour === 8 && minute === 9) {
          lastNotifiedDateRef.current.checkIn = todayDate;
          sendBrowserNotification(
            '⏰ Pengingat Check-In (08:09 WIB)',
            'Pukul 08:09 WIB! Batas waktu Check-In On Time tinggal 1 menit (08:10 WIB). Segera lakukan check-in sekarang!',
            'checkin-alert'
          );
        }
        return;
      }

      // 2. EVALUATE CHECK-OUT FLASH ALERT (Jam 19.00 WIB ke atas)
      const hasOpenShiftOrCheckedIn = Boolean(
        activeAttendance ||
        (todayAttendance?.checkIn && !todayAttendance?.checkOut)
      );

      // Trigger if hour >= 19 (19:00 WIB ke atas) and belum check-out
      const isEveningCheckOutTime = hour >= 19;

      if (hasOpenShiftOrCheckedIn && isEveningCheckOutTime) {
        setActiveAlert('checkOut');
        setCountdownSeconds(null);

        // Send browser notification once per date
        if (lastNotifiedDateRef.current.checkOut !== todayDate) {
          lastNotifiedDateRef.current.checkOut = todayDate;
          sendBrowserNotification(
            '🔔 Pengingat Check-Out (19:00 WIB)',
            'Waktu saat ini telah melewati pukul 19:00 WIB. Jangan lupa untuk melakukan Check-Out absensi Anda.',
            'checkout-alert'
          );
        }
        return;
      }

      // No active alerts
      setActiveAlert(null);
      setCountdownSeconds(null);
    };

    evaluateAlerts();
    checkIntervalRef.current = window.setInterval(evaluateAlerts, 1000);
    return () => window.clearInterval(checkIntervalRef.current);
  }, [user, userData, todayAttendance, activeAttendance, snoozedUntil, sendBrowserNotification]);

  const handleAction = () => {
    requestBrowserNotificationPermission();
    if (location.pathname !== '/employee') {
      navigate('/employee');
    } else {
      // Scroll to attendance action card or trigger
      const actionElement = document.getElementById('attendance-action-section') || document.getElementById('root');
      if (actionElement) {
        actionElement.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  const handleSnooze = (minutes = 3) => {
    setSnoozedUntil(Date.now() + minutes * 60 * 1000);
    setActiveAlert(null);
  };

  if (!activeAlert) {
    return null;
  }

  return (
    <aside
      role="region"
      aria-label="Pemberitahuan Absensi"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-50 w-[95%] max-w-2xl animate-bounce-short"
    >
      {activeAlert === 'checkIn' ? (
        <div className="bg-gradient-to-r from-amber-600 via-red-600 to-rose-600 text-white rounded-2xl shadow-2xl p-4 md:p-5 border-2 border-yellow-300 ring-4 ring-red-400/40 relative overflow-hidden backdrop-blur-md">
          {/* Glowing pulse background animation */}
          <div className="absolute inset-0 bg-white/10 animate-pulse pointer-events-none" />

          <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center shrink-0 shadow-inner">
                <span className="text-2xl">⏰</span>
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="bg-yellow-300 text-amber-950 font-black text-xs px-2.5 py-0.5 rounded-full uppercase tracking-wider shadow-sm">
                    Penting · 08.09 WIB
                  </span>
                  <span className="text-xs text-yellow-100 font-mono">
                    {wibTimeStr}
                  </span>
                  {countdownSeconds !== null && countdownSeconds > 0 && (
                    <span className="bg-red-900/80 text-yellow-200 text-xs px-2 py-0.5 rounded-md font-mono font-bold animate-pulse">
                      Tersisa {countdownSeconds}s menuju 08:10
                    </span>
                  )}
                </div>
                <h4 className="font-bold text-base md:text-lg mt-1 text-white tracking-tight">
                  Peringatan: Anda Belum Check-In Hari Ini!
                </h4>
                <p className="text-xs md:text-sm text-yellow-100 mt-0.5 leading-relaxed">
                  Batas waktu Check-In kategori <strong>On Time</strong> adalah maksimal pukul <strong>08:10 WIB</strong>. Segera lakukan Check-In selfie & GPS sekarang agar tidak terhitung terlambat!
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto shrink-0 justify-end mt-1 md:mt-0">
              <button
                type="button"
                onClick={() => handleSnooze(2)}
                className="px-3 py-2 text-xs font-semibold bg-white/15 hover:bg-white/25 rounded-xl transition text-white"
                title="Tunda 2 menit"
              >
                Nanti
              </button>
              <button
                type="button"
                onClick={handleAction}
                className="flex-1 md:flex-initial px-5 py-2.5 text-sm font-bold bg-yellow-300 hover:bg-yellow-200 text-amber-950 rounded-xl shadow-lg hover:shadow-yellow-300/40 transition transform active:scale-95 flex items-center justify-center gap-1.5"
              >
                <span>⚡</span>
                <span>Check-In Sekarang</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-gradient-to-r from-blue-700 via-indigo-700 to-purple-800 text-white rounded-2xl shadow-2xl p-4 md:p-5 border-2 border-indigo-300 ring-4 ring-indigo-400/40 relative overflow-hidden backdrop-blur-md">
          {/* Glowing pulse background animation */}
          <div className="absolute inset-0 bg-white/10 animate-pulse pointer-events-none" />

          <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center shrink-0 shadow-inner">
                <span className="text-2xl">🔔</span>
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="bg-cyan-300 text-indigo-950 font-black text-xs px-2.5 py-0.5 rounded-full uppercase tracking-wider shadow-sm">
                    Pengingat · 19.00 WIB
                  </span>
                  <span className="text-xs text-indigo-200 font-mono">
                    {wibTimeStr}
                  </span>
                </div>
                <h4 className="font-bold text-base md:text-lg mt-1 text-white tracking-tight">
                  Pengingat: Jangan Lupa Check-Out Absensi!
                </h4>
                <p className="text-xs md:text-sm text-indigo-100 mt-0.5 leading-relaxed">
                  Waktu telah melewati pukul <strong>19:00 WIB</strong> dan Anda belum menyelesaikan Check-Out untuk shift hari ini. Silakan selesaikan absensi pulang Anda.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto shrink-0 justify-end mt-1 md:mt-0">
              <button
                type="button"
                onClick={() => handleSnooze(5)}
                className="px-3 py-2 text-xs font-semibold bg-white/15 hover:bg-white/25 rounded-xl transition text-white"
                title="Tunda 5 menit"
              >
                Nanti
              </button>
              <button
                type="button"
                onClick={handleAction}
                className="flex-1 md:flex-initial px-5 py-2.5 text-sm font-bold bg-cyan-300 hover:bg-cyan-200 text-indigo-950 rounded-xl shadow-lg hover:shadow-cyan-300/40 transition transform active:scale-95 flex items-center justify-center gap-1.5"
              >
                <span>⚡</span>
                <span>Check-Out Sekarang</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

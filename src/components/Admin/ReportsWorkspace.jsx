// src/components/Admin/ReportsWorkspace.jsx
//
// Tab Reports dibagi dua: arsip bukti yang ditelusuri per pegawai, dan laporan
// detail beserta ekspornya. Keduanya membaca sumber data yang sama lewat
// attendanceReportData, jadi angkanya tidak bisa berbeda antar layar.
import { useState } from 'react';

import AttendanceArchive from './AttendanceArchive';
import MonthlyReports from './MonthlyReports';

const VIEWS = [
  {
    key: 'archive',
    label: '🗂️ Arsip Bukti per Pegawai',
    hint: 'Telusuri periode → pegawai → catatan harian, lokasi, dan foto bukti.',
  },
  {
    key: 'detail',
    label: '📊 Laporan Detail & Ekspor',
    hint: 'Ringkasan periode dan ekspor Excel seluruh record.',
  },
];

function ReportsWorkspace() {
  const [activeView, setActiveView] = useState('archive');
  const active = VIEWS.find((view) => view.key === activeView) ?? VIEWS[0];

  return (
    <div className="space-y-5">
      <div className="rounded-xl bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {VIEWS.map((view) => (
            <button
              key={view.key}
              onClick={() => setActiveView(view.key)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                activeView === view.key
                  ? 'bg-green-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {view.label}
            </button>
          ))}
        </div>
        <p className="px-2 pb-1 pt-2 text-xs text-gray-500">{active.hint}</p>
      </div>

      {activeView === 'archive' ? <AttendanceArchive /> : <MonthlyReports />}
    </div>
  );
}

export default ReportsWorkspace;

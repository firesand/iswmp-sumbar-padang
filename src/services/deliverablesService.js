// src/services/deliverablesService.js
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  setDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import {
  deleteObject,
  ref,
  uploadBytesResumable,
  getDownloadURL,
} from 'firebase/storage';
import { auth, db, storage } from '../config/firebase.js';
import { getAppUrl } from '../config/projectConfig.js';

export const DELIVERABLE_CATEGORIES = [
  { id: 'pendahuluan', label: '1. Laporan Pendahuluan', badge: 'H+25 SPMK' },
  { id: 'bulanan', label: '2. Laporan Bulanan (10)', badge: 'Bulanan' },
  { id: 'triwulanan', label: '3. Laporan Triwulanan & PPT', badge: 'Triwulan' },
  { id: 'akhir', label: '4. Laporan Akhir & SSD 1TB', badge: 'Akhir Kontrak' },
  { id: 'kegiatan_boq', label: '5. Dokumentasi Kegiatan BOQ (16)', badge: 'Foto & Video' },
];

export const KAK_DELIVERABLES_CONFIG = [
  // 1. Laporan Pendahuluan
  {
    id: 'laporan_pendahuluan',
    category: 'pendahuluan',
    code: 'LP',
    title: 'Laporan Pendahuluan (Inception Report)',
    subtitle: 'Waktu penyampaian: Maksimal 25 hari kalender sejak SPMK (3 eksemplar + pembahasan Tim Bantuan Teknis)',
    targetDate: '2026-08-07',
    deadlineLabel: 'Maksimal 25 hari kalender sejak SPMK (07 Agustus 2026)',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis Balai PU Padang',
    scopeItems: [
      'Gambaran umum pelaksanaan kegiatan dan pendekatan pendampingan',
      'Hasil review awal dokumen perencanaan dan strategi/pedoman pengelolaan sampah di hulu',
      'Pemetaan pemangku kepentingan dan kondisi awal kelembagaan serta layanan pengumpulan sampah di lokasi kegiatan',
      'Penetapan baseline awal untuk indikator penilaian kinerja',
      'Identifikasi risiko awal pelaksanaan kegiatan dan langkah mitigasi',
      'Rencana kerja rinci (Workplan) dan jadwal pelaksanaan kegiatan',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Pendahuluan (.pdf / .docx)',
      'Matriks Rencana Kerja Rinci & Jadwal (.xlsx / .pdf)',
      'Berita Acara Pembahasan dengan Tim Bantuan Teknis (.pdf)',
    ],
  },

  // 2. Laporan Bulanan (Bulan 1 s.d. 10)
  {
    id: 'laporan_bulanan_01',
    category: 'bulanan',
    monthNumber: 1,
    code: 'LB-01',
    title: 'Laporan Bulanan Ke-1 (Periode 13 Jul – 12 Agu 2026)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2026-08-19',
    deadlineLabel: '19 Agustus 2026 (Akhir Minggu Ke-1 Bulan ke-2)',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen Rencana Teknis Pengelolaan Sampah (RTPS)',
      'Dokumen Pembentukan/Penguatan Kelembagaan Pengelola Sampah di Hulu',
      'Progres pelaksanaan kegiatan pendampingan di setiap lokasi',
      'Capaian kegiatan lapangan (pendampingan masyarakat, penguatan kelembagaan, operasional layanan)',
      'Kendala pelaksanaan dan langkah tindak lanjut',
      'Ringkasan data capaian layanan dan absensi kegiatan lapangan',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-1 (.pdf / .docx)',
      'Dokumen RTPS Hulu (.pdf / .docx)',
      'Dokumen Kelembagaan Pengelola Sampah (.pdf / .docx)',
      'Rekapitulasi Data Capaian Layanan (.xlsx / .pdf)',
    ],
  },
  {
    id: 'laporan_bulanan_02',
    category: 'bulanan',
    monthNumber: 2,
    code: 'LB-02',
    title: 'Laporan Bulanan Ke-2 (Periode 13 Agu – 12 Sep 2026)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2026-09-19',
    deadlineLabel: '19 September 2026',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen Rencana Teknis Pengelolaan Sampah (RTPS) - Pemutakhiran',
      'Dokumen Pembentukan/Penguatan Kelembagaan Pengelola Sampah di Hulu',
      'Progres pelaksanaan kegiatan pendampingan di setiap lokasi',
      'Capaian kegiatan lapangan (pendampingan masyarakat, penguatan kelembagaan, operasional layanan)',
      'Kendala pelaksanaan dan langkah tindak lanjut',
      'Ringkasan data capaian layanan dan kegiatan lapangan',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-2 (.pdf / .docx)',
      'Progres RTPS & Kelembagaan (.pdf / .docx)',
      'Rekapitulasi Data Capaian Lapangan (.xlsx / .pdf)',
    ],
  },
  {
    id: 'laporan_bulanan_03',
    category: 'bulanan',
    monthNumber: 3,
    code: 'LB-03',
    title: 'Laporan Bulanan Ke-3 (Periode 13 Sep – 12 Okt 2026)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2026-10-19',
    deadlineLabel: '19 Oktober 2026',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen Rencana Teknis Pengelolaan Sampah (RTPS)',
      'Dokumen Pembentukan/Penguatan Kelembagaan Pengelola Sampah di Hulu',
      'Progres pelaksanaan kegiatan pendampingan di setiap lokasi',
      'Capaian kegiatan lapangan (pendampingan masyarakat, penguatan kelembagaan, operasional layanan)',
      'Kendala pelaksanaan dan langkah tindak lanjut',
      'Ringkasan data capaian layanan dan kegiatan lapangan',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-3 (.pdf / .docx)',
      'Dokumen Pendukung RTPS & Monev Lapangan (.pdf)',
    ],
  },
  {
    id: 'laporan_bulanan_04',
    category: 'bulanan',
    monthNumber: 4,
    code: 'LB-04',
    title: 'Laporan Bulanan Ke-4 (Periode 13 Okt – 12 Nov 2026)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2026-11-19',
    deadlineLabel: '19 November 2026',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen Rencana Teknis Pengelolaan Sampah (RTPS)',
      'Dokumen Penguatan Kelembagaan Pengelola Sampah di Hulu',
      'Progres pelaksanaan kegiatan pendampingan di setiap lokasi',
      'Capaian kegiatan lapangan & operasional layanan',
      'Kendala pelaksanaan dan langkah tindak lanjut',
      'Ringkasan data capaian layanan dan kegiatan lapangan',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-4 (.pdf / .docx)',
    ],
  },
  {
    id: 'laporan_bulanan_05',
    category: 'bulanan',
    monthNumber: 5,
    code: 'LB-05',
    title: 'Laporan Bulanan Ke-5 (Periode 13 Nov – 12 Des 2026)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2026-12-19',
    deadlineLabel: '19 Desember 2026',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen RTPS & Operasional Layanan Hulu',
      'Dokumen Penguatan Kelembagaan Pengelola Sampah',
      'Progres pelaksanaan kegiatan pendampingan per lokasi',
      'Capaian kegiatan lapangan & monitoring layanan',
      'Kendala pelaksanaan dan langkah tindak lanjut',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-5 (.pdf / .docx)',
    ],
  },
  {
    id: 'laporan_bulanan_06',
    category: 'bulanan',
    monthNumber: 6,
    code: 'LB-06',
    title: 'Laporan Bulanan Ke-6 (Periode 13 Des 2026 – 12 Jan 2027)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2027-01-19',
    deadlineLabel: '19 Januari 2027',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen Rencana Teknis Pengelolaan Sampah (RTPS)',
      'Dokumen Pembentukan/Penguatan Kelembagaan Pengelola Sampah di Hulu',
      'Progres pelaksanaan kegiatan pendampingan di setiap lokasi',
      'Capaian kegiatan lapangan & evaluasi semester 1',
      'Kendala pelaksanaan dan langkah tindak lanjut',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-6 (.pdf / .docx)',
    ],
  },
  {
    id: 'laporan_bulanan_07',
    category: 'bulanan',
    monthNumber: 7,
    code: 'LB-07',
    title: 'Laporan Bulanan Ke-7 (Periode 13 Jan – 12 Feb 2027)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2027-02-19',
    deadlineLabel: '19 Februari 2027',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen Rencana Teknis Pengelolaan Sampah (RTPS)',
      'Dokumen Pembentukan/Penguatan Kelembagaan',
      'Progres pendampingan lapangan & perluasan layanan',
      'Capaian kegiatan lapangan & kendala/tindak lanjut',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-7 (.pdf / .docx)',
    ],
  },
  {
    id: 'laporan_bulanan_08',
    category: 'bulanan',
    monthNumber: 8,
    code: 'LB-08',
    title: 'Laporan Bulanan Ke-8 (Periode 13 Feb – 12 Mar 2027)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2027-03-19',
    deadlineLabel: '19 Maret 2027',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen RTPS & Kelembagaan Hulu',
      'Progres pelaksanaan pendampingan per lokasi',
      'Capaian kegiatan lapangan dan penguatan kelembagaan',
      'Kendala pelaksanaan dan langkah tindak lanjut',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-8 (.pdf / .docx)',
    ],
  },
  {
    id: 'laporan_bulanan_09',
    category: 'bulanan',
    monthNumber: 9,
    code: 'LB-09',
    title: 'Laporan Bulanan Ke-9 (Periode 13 Mar – 12 Apr 2027)',
    subtitle: 'Waktu penyampaian: Selambat-lambatnya 1 minggu setelah bulan pengamatan berakhir',
    targetDate: '2027-04-19',
    deadlineLabel: '19 April 2027',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen RTPS & Evaluasi Layanan Hulu',
      'Dokumen Pembentukan/Penguatan Kelembagaan',
      'Progres pendampingan menuju fase akhir',
      'Capaian kegiatan lapangan dan persiapan penyerahan',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-9 (.pdf / .docx)',
    ],
  },
  {
    id: 'laporan_bulanan_10',
    category: 'bulanan',
    monthNumber: 10,
    code: 'LB-10',
    title: 'Laporan Bulanan Ke-10 (Periode 13 Apr – 08 Mei 2027)',
    subtitle: 'Waktu penyampaian: Akhir masa kontrak (Hari ke-300)',
    targetDate: '2027-05-08',
    deadlineLabel: '08 Mei 2027 (Penutupan Kontrak 300 Hari)',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis / PPK Balai PU',
    scopeItems: [
      'Dokumen Final RTPS & Serah Terima Kelembagaan',
      'Rekapitulasi total progres pendampingan seluruh lokasi',
      'Capaian akhir operasional layanan dan kelembagaan hulu',
      'Ringkasan data capaian layanan menyeluruh',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Bulanan Ke-10 (.pdf / .docx)',
    ],
  },

  // 3. Laporan Triwulanan & Presentasi BPBPK
  {
    id: 'laporan_triwulan_01',
    category: 'triwulanan',
    quarterNumber: 1,
    code: 'LTW-01',
    title: 'Laporan Triwulanan I (Triwulan 1 & Bahan Presentasi)',
    subtitle: 'Waktu penyampaian: Disampaikan ke BPBPK (Rapat Offline CPIU, BPBPK, NPMC, IPCI, KorKot, dll.)',
    targetDate: '2026-10-20',
    deadlineLabel: '20 Oktober 2026 (Bulan ke-3 Kontrak)',
    copiesRequired: 3,
    discussionRequired: 'Rapat Offline BPBPK (CPIU, BPBPK, NPMC, IPCI, KorKot, Asman Data)',
    scopeItems: [
      'Analisis capaian pelaksanaan kegiatan dibandingkan dengan rencana kerja',
      'Evaluasi kualitas implementasi dan pendampingan lapangan',
      'Hasil monitoring dan evaluasi serta pembelajaran awal',
      'Rencana Kerja dan Tindak Lanjut (RKTL) 3 bulan ke depan & strategi pencapaian kegiatan',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Laporan Tiga Bulanan I (.pdf / .docx)',
      'Bahan Presentasi Slide Rapat BPBPK (.pptx / .pdf)',
      'Matriks RKTL 3 Bulan ke Depan (.xlsx / .pdf)',
      'Notulensi / Berita Acara Rapat BPBPK (.pdf)',
    ],
  },
  {
    id: 'laporan_triwulan_02',
    category: 'triwulanan',
    quarterNumber: 2,
    code: 'LTW-02',
    title: 'Laporan Triwulanan II (Triwulan 2 & Bahan Presentasi)',
    subtitle: 'Waktu penyampaian: Disampaikan ke BPBPK (Rapat Offline)',
    targetDate: '2027-01-20',
    deadlineLabel: '20 Januari 2027 (Bulan ke-6 Kontrak)',
    copiesRequired: 3,
    discussionRequired: 'Rapat Offline BPBPK',
    scopeItems: [
      'Analisis capaian pelaksanaan kegiatan triwulan II vs rencana kerja',
      'Evaluasi kualitas implementasi dan pendampingan lapangan',
      'Hasil monitoring dan evaluasi serta pembelajaran semester 1',
      'Rencana Kerja dan Tindak Lanjut (RKTL) triwulan III',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Laporan Tiga Bulanan II (.pdf / .docx)',
      'Bahan Presentasi Slide Rapat BPBPK (.pptx / .pdf)',
      'Matriks RKTL Periode Berikutnya (.xlsx / .pdf)',
    ],
  },
  {
    id: 'laporan_triwulan_03',
    category: 'triwulanan',
    quarterNumber: 3,
    code: 'LTW-03',
    title: 'Laporan Triwulanan III (Triwulan 3 & Bahan Presentasi)',
    subtitle: 'Waktu penyampaian: Disampaikan ke BPBPK (Rapat Offline)',
    targetDate: '2027-04-20',
    deadlineLabel: '20 April 2027 (Bulan ke-9 Kontrak)',
    copiesRequired: 3,
    discussionRequired: 'Rapat Offline BPBPK',
    scopeItems: [
      'Analisis capaian pelaksanaan kegiatan triwulan III vs rencana kerja',
      'Evaluasi kualitas implementasi dan pendampingan lapangan',
      'Hasil monitoring dan evaluasi',
      'Rencana Kerja dan Tindak Lanjut (RKTL) menuju akhir kontrak',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Laporan Tiga Bulanan III (.pdf / .docx)',
      'Bahan Presentasi Slide Rapat BPBPK (.pptx / .pdf)',
      'Matriks RKTL Final (.xlsx / .pdf)',
    ],
  },

  // 4. Laporan Akhir & Master Deliverables
  {
    id: 'laporan_akhir',
    category: 'akhir',
    code: 'LA-FINAL',
    title: 'Laporan Akhir (Final Report) & Master Deliverables SSD 1TB',
    subtitle: 'Waktu penyampaian: Paling lambat pada akhir masa kontrak (3 eksemplar + pembahasan Tim Bantuan Teknis + 1 Unit SSD 1TB)',
    targetDate: '2027-05-08',
    deadlineLabel: '08 Mei 2027 (Hari ke-300 Masa Kontrak)',
    copiesRequired: 3,
    discussionRequired: 'Tim Bantuan Teknis & Balai PU Padang',
    scopeItems: [
      'Implementasi & Dokumentasi Percontohan Layanan Pengumpulan Sampah Terpilah',
      'Basis Data Objek Layanan (By Name By Address / BNBA)',
      'Ringkasan keseluruhan proses dan hasil pelaksanaan kegiatan',
      'Capaian output dan outcome kegiatan',
      'Evaluasi pelaksanaan pendampingan dan efektivitas implementasi',
      'Kendala, solusi, dan pembelajaran (lessons learned)',
      'Rekomendasi untuk keberlanjutan penyelenggaraan layanan pengelolaan sampah di hulu',
    ],
    requiredDeliverableOutputs: [
      'Dokumen Utama Laporan Akhir (.pdf / .docx)',
      'Master Basis Data Objek Layanan By Name By Address (.xlsx / .csv)',
      'Dokumentasi Komprehensif & Percontohan Layanan Terpilah (.pdf)',
      'Berita Acara Serah Terima Softcopy SSD 1TB (.pdf)',
    ],
  },

  // ==========================================
  // 5. DOKUMENTASI KEGIATAN BOQ KONTRAK (16)
  // ==========================================
  {
    id: 'boq_kick_off_meeting',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.1',
    isBoqActivity: true,
    title: 'Kick Off Meeting Bersama Balai PU Padang & Stakeholders',
    subtitle: 'BOQ IV.1: Konsumsi 50 org/kali, Transport Petugas Lapangan 22 org, Narasumber 2 JP',
    boqRef: 'IV.1 Kick Off Meeting',
    copiesRequired: 1,
    discussionRequired: 'Balai Penataan Bangunan, Prasarana dan Kawasan Sumbar & Tim Teknis',
    scopeItems: [
      'Pemaparan Kerangka Acuan Kerja (KAK) dan Rencana Kerja Konsultan Manajemen',
      'Penyelarasan target capaian pendampingan 11 kelurahan di Kota Padang',
      'Dokumentasi foto kegiatan per sesi dan rekaman video/ringkasan acara',
      'Notula rapat, Berita Acara Kick Off, dan daftar hadir peserta lengkap',
    ],
    requiredDeliverableOutputs: [
      'Foto-Foto Dokumentasi Pelaksanaan (.jpg / .png / .webp)',
      'Video / Dokumentasi Visual Kegiatan (.mp4 / link drive)',
      'Notula Rapat & Berita Acara Kick Off Meeting (.pdf)',
      'Daftar Hadir Peserta Rapat (.pdf / .xlsx)',
    ],
  },
  {
    id: 'boq_bimtek_petugas_lapangan',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.4',
    isBoqActivity: true,
    title: 'Bimbingan Teknis Petugas Lapangan & Pelatihan Fasilitator (Fullboard 3 Hari)',
    subtitle: 'BOQ IV.4: Fullboard 60 org/hari x 3 hari, Materi Kit 60 buah, Narasumber 12 JP, Transport 22 org x 3 hari',
    boqRef: 'IV.4 Bimbingan Teknis Petugas Lapangan',
    copiesRequired: 1,
    discussionRequired: 'Tim Ahli Konsultan & Tim Teknis Balai PU',
    scopeItems: [
      'Pelatihan fasilitator pendampingan persampahan terpilah di 11 kelurahan',
      'Penyampaian materi teknik pemilahan hulu, kelembagaan RTPS, dan tata kelola kelurahan',
      'Simulasi pengumpulan basis data BNBA dan pendampingan lapangan',
      'Dokumentasi foto tiap sesi pelatihan dan video simulasi/testimoni',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Kegiatan Pelatihan (.jpg / .png)',
      'Video Dokumentasi Sesi BimTek & Simulasi (.mp4 / link)',
      'Materi Pelatihan & Modul Fasilitator (.pdf / .pptx)',
      'Berita Acara & Daftar Hadir Peserta 3 Hari (.pdf)',
    ],
  },
  {
    id: 'boq_sosialisasi_awal_kota',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.B.1',
    isBoqActivity: true,
    title: 'Sosialisasi Awal Pelaksanaan Kegiatan & Pengembangan Organisasi (Tingkat Kota)',
    subtitle: 'BOQ IV.B.1: Paket Fullday 75 org/hari, Transport Petugas 22 org',
    boqRef: 'IV.B.1 Sosialisasi Awal Tingkat Kota',
    copiesRequired: 1,
    discussionRequired: 'Pemda Kota Padang, DLH, Bappeda, Camat & Lurah 11 Kelurahan',
    scopeItems: [
      'Sosialisasi program ISWMP tingkat Kota Padang bersama dinas terkait dan 11 kelurahan',
      'Pemaparan model tata kelola organisasi layanan pengumpulan sampah terpilah',
      'Penggalangan komitmen bersama pemangku kepentingan tingkat Kota Padang',
      'Dokumentasi foto plenary sosialisasi, video dokumenter, dan daftar hadir',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Sosialisasi (.jpg / .png)',
      'Video Dokumentasi Acara Sosialisasi (.mp4 / link)',
      'Notula, Berita Acara & Daftar Hadir Peserta (.pdf)',
    ],
  },
  {
    id: 'boq_rapat_rtps_kota',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.B.2',
    isBoqActivity: true,
    title: 'Rapat Penyusunan Rencana Teknis Pengelolaan Sampah (RTPS) Tingkat Kota (3x Rapat)',
    subtitle: 'BOQ IV.B.2: 25 org/rapat x 3 kali rapat (Konsumsi 75 pax, Narasumber 6 JP)',
    boqRef: 'IV.B.2 Rapat RTPS Tingkat Kota',
    copiesRequired: 1,
    discussionRequired: 'Tim Teknis Dinas Lingkungan Hidup Kota Padang & Bappeda',
    scopeItems: [
      'Penyusunan kerangka dan materi draf RTPS Kota Padang',
      'Pembahasan teknis rute pengumpulan, sarana prasarana, dan jadwal pengangkutan terpilah',
      'Finalisasi dokumen implementasi operasional RTPS Kota Padang',
      'Dokumentasi foto rapat per sesi pembahasan',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi 3 Kali Rapat (.jpg / .png)',
      'Dokumen Draf & Final RTPS Kota Padang (.pdf / .docx)',
      'Notula Rapat & Daftar Hadir (.pdf)',
    ],
  },
  {
    id: 'boq_rapat_kelembagaan_kota',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.B.3',
    isBoqActivity: true,
    title: 'Rapat Pembentukan dan/atau Penguatan Kelembagaan Tingkat Kota (3x Rapat)',
    subtitle: 'BOQ IV.B.3: 25 org/rapat x 3 kali rapat (Konsumsi 75 pax, Narasumber 6 JP)',
    boqRef: 'IV.B.3 Rapat Kelembagaan Kota',
    copiesRequired: 1,
    discussionRequired: 'Bagian Organisasi Pemda Padang, DLH & Tim Ahli Kelembagaan',
    scopeItems: [
      'Perumusan struktur tata kelola kelembagaan pengelola sampah terpilah',
      'Penyusunan SOP dan mekanisme operasional kelompok pengelola',
      'Harmonisasi dengan regulasi persampahan daerah Kota Padang',
      'Dokumentasi foto rapat dan pembahasan pasal-pasal kelembagaan',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Rapat (.jpg / .png)',
      'Matriks Struktur Kelembagaan & SOP (.pdf / .docx)',
      'Notula & Daftar Hadir Rapat (.pdf)',
    ],
  },
  {
    id: 'boq_rapat_implementasi_kota',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.B.4',
    isBoqActivity: true,
    title: 'Rapat Implementasi & Pendampingan Operasional Kelembagaan Tingkat Kota (3x Rapat)',
    subtitle: 'BOQ IV.B.4: 25 org/rapat x 3 kali rapat (Konsumsi 75 pax, Narasumber 6 JP)',
    boqRef: 'IV.B.4 Implementasi & Pendampingan Kota',
    copiesRequired: 1,
    discussionRequired: 'Tim Bantuan Teknis & Tim Pendamping Lapangan',
    scopeItems: [
      'Evaluasi progres pendampingan kelembagaan di 11 kelurahan',
      'Penyelesaian kendala kelembagaan dan koordinasi lintas sektor',
      'Penguatan peran pengawas dan tim pendamping lapangan',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Rapat (.jpg / .png)',
      'Laporan Progres Kelembagaan (.pdf)',
      'Notula & Daftar Hadir (.pdf)',
    ],
  },
  {
    id: 'boq_rapat_serah_terima_pemda',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.B.5',
    isBoqActivity: true,
    title: 'Rapat Kegiatan Serah Terima Sistem Pengelolaan Sampah ke Pemda Kota Padang',
    subtitle: 'BOQ IV.B.5: Konsumsi 50 orang/kali',
    boqRef: 'IV.B.5 Serah Terima ke Pemda',
    copiesRequired: 1,
    discussionRequired: 'Pemerintah Kota Padang & Balai Penataan Bangunan Prasarana Kawasan',
    scopeItems: [
      'Penyampaian hasil akhir pendampingan pembentukan tata kelola sampah terpilah di 11 kelurahan',
      'Penyerahan dokumen sistem operasional ke Pemda Kota Padang / DLH',
      'Penandatanganan Berita Acara Serah Terima (BAST) hasil pendampingan',
      'Dokumentasi seremonial penyerahan dan video dokumenter',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Serah Terima (.jpg / .png)',
      'Video Acara Serah Terima (.mp4 / link)',
      'Berita Acara Serah Terima (BAST) (.pdf)',
      'Daftar Hadir Undangan (.pdf)',
    ],
  },
  {
    id: 'boq_fgd_rw_11_kelurahan',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.Desa.1',
    isBoqActivity: true,
    title: 'FGD Penyepakatan Sistem Pengelolaan Sampah Tingkat Basis (RW) di 11 Kelurahan',
    subtitle: 'BOQ IV.Desa.1: 500 pax/lokasi x 11 Kelurahan (Total 5.500 pax)',
    boqRef: 'IV.Desa.1 FGD Basis RW (11 Kelurahan)',
    copiesRequired: 1,
    discussionRequired: 'Warga RW/RT, Tokoh Masyarakat & Lurah 11 Kelurahan',
    scopeItems: [
      'Pelaksanaan FGD rembuk warga/RW di 11 kelurahan sasaran',
      'Penyepakatan mekanisme pemilahan sampah di tingkat rumah tangga',
      'Kesepakatan jadwal dan titik kumpul pengumpulan terpilah',
      'Dokumentasi foto rembuk per RW dan video aspirasi warga',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi FGD di 11 Kelurahan (.jpg / .png)',
      'Video Singkat / Dokumentasi FGD (.mp4 / link)',
      'Berita Acara Kesepakatan Warga per Kelurahan (.pdf)',
      'Daftar Hadir Peserta FGD RW (.pdf / .xlsx)',
    ],
  },
  {
    id: 'boq_pengorganisasian_hulu_11_kelurahan',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.Desa.2',
    isBoqActivity: true,
    title: 'Pengorganisasian Pengelolaan Sampah Secara Terpilah di Hulu di 11 Kelurahan',
    subtitle: 'BOQ IV.Desa.2: 50 pax/lokasi x 11 Kelurahan (Total 550 pax)',
    boqRef: 'IV.Desa.2 Pengorganisasian Hulu',
    copiesRequired: 1,
    discussionRequired: 'Kelompok Swadaya Masyarakat (KSM) & Kader Kelurahan',
    scopeItems: [
      'Pembentukan kelompok kerja pengelola sampah di tingkat hulu/kelurahan',
      'Pelatihan pemilahan sampah organik dan anorganik bagi kader kelurahan',
      'Penyusunan basis data awal rumah tangga binaan',
      'Dokumentasi foto pembentukan kelompok kerja',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Pengorganisasian (.jpg / .png)',
      'Struktur Kelompok Kerja Hulu Kelurahan (.pdf)',
      'Notula & Daftar Hadir Peserta (.pdf)',
    ],
  },
  {
    id: 'boq_rapat_rtps_11_kelurahan',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.Desa.3',
    isBoqActivity: true,
    title: 'Rapat Penyusunan Dokumen RTPS di 11 Kelurahan (11 Kelurahan x 3 Kali Rapat)',
    subtitle: 'BOQ IV.Desa.3: 75 pax x 11 Kelurahan (Total 825 pax, Narasumber 66 JP)',
    boqRef: 'IV.Desa.3 RTPS 11 Kelurahan',
    copiesRequired: 1,
    discussionRequired: 'Aparatur Kelurahan, LPM & Pengurus TPS3R',
    scopeItems: [
      'Penyusunan dokumen Rencana Teknis Pengelolaan Sampah (RTPS) spesifik untuk 11 kelurahan',
      'Pemetaan rute ritase pengumpulan motor sampah per RW/RT',
      'Penetapan kebutuhan sarana dan jadwal pengangkutan terpilah',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Rapat RTPS 11 Kelurahan (.jpg / .png)',
      'Kumpulan 11 Dokumen RTPS Kelurahan (.pdf / .docx)',
      'Notula & Daftar Hadir (.pdf)',
    ],
  },
  {
    id: 'boq_pembentukan_kelembagaan_11_kelurahan',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.Desa.4',
    isBoqActivity: true,
    title: 'Rapat Pembentukan dan/atau Penguatan Kelembagaan di 11 Kelurahan (11 Kelurahan x 3 Rapat)',
    subtitle: 'BOQ IV.Desa.4: 75 pax x 11 Kelurahan (Total 825 pax, Narasumber 66 JP)',
    boqRef: 'IV.Desa.4 Kelembagaan 11 Kelurahan',
    copiesRequired: 1,
    discussionRequired: 'Lurah, LPM, Tokoh Masyarakat & Kader Persampahan',
    scopeItems: [
      'Pembentukan Surat Keputusan (SK) Lembaga Pengelola Sampah Kelurahan',
      'Penyusunan Anggaran Dasar / Anggaran Rumah Tangga (AD/ART) & SOP Layanan',
      'Penetapan pengurus dan pembagian tugas operasional',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Rapat Kelembagaan (.jpg / .png)',
      'Salinan SK Kelembagaan 11 Kelurahan (.pdf)',
      'Dokumen AD/ART & SOP Lembaga Kelurahan (.pdf)',
      'Daftar Hadir Peserta (.pdf)',
    ],
  },
  {
    id: 'boq_pendampingan_kelembagaan_11_kelurahan',
    category: 'kegiatan_boq',
    code: 'BOQ-IV.Desa.5',
    isBoqActivity: true,
    title: 'Rapat Implementasi dan Pendampingan Operasional Kelembagaan di 11 Kelurahan (3x Rapat)',
    subtitle: 'BOQ IV.Desa.5: 75 pax x 11 Kelurahan (Total 825 pax, Narasumber 66 JP)',
    boqRef: 'IV.Desa.5 Pendampingan 11 Kelurahan',
    copiesRequired: 1,
    discussionRequired: 'Pengurus Pengelola Sampah Kelurahan & Petugas Angkut',
    scopeItems: [
      'Pendampingan intensif operasional kelembagaan dan pencatatan iuran/retribusi',
      'Monitoring kinerja petugas pengumpul dan ketepatan pemilahan hulu',
      'Evaluasi berkala kepatuhan pemilahan di tingkat rumah tangga',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Pendampingan (.jpg / .png)',
      'Laporan Hasil Pendampingan Operasional Kelurahan (.pdf)',
      'Notula Rapat & Daftar Hadir (.pdf)',
    ],
  },
  {
    id: 'boq_rapat_rutin_tatakelola_desa',
    category: 'kegiatan_boq',
    code: 'BOQ-V.1',
    isBoqActivity: true,
    title: 'Rapat Rutin Tatakelola Organisasi Layanan Pengumpulan Sampah Terpilah (11 Kelurahan x 6 Rapat)',
    subtitle: 'BOQ V.1: @10 org/desa x 6 kali rapat (Total 660 org-lokasi)',
    boqRef: 'V.1 Rapat Rutin Tatakelola (660 org)',
    copiesRequired: 1,
    discussionRequired: 'Pengurus Lembaga Pengelola Sampah 11 Kelurahan',
    scopeItems: [
      'Rapat koordinasi rutin bulanan pengurus pengelola sampah di masing-masing kelurahan',
      'Review catatan pembukuan, iuran layanan, dan pencatatan tonase sampah',
      'Penyelesaian kendala teknis harian di lapangan',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Rapat Rutin Kelurahan (.jpg / .png)',
      'Notula Pembahasan & Rekap Kehadiran Rapat (.pdf)',
    ],
  },
  {
    id: 'boq_rapat_koordinasi_fasilitator',
    category: 'kegiatan_boq',
    code: 'BOQ-V.2',
    isBoqActivity: true,
    title: 'Rapat Koordinasi Bulanan Tim Fasilitator & Tenaga Pendamping Lapangan (10 Bulan)',
    subtitle: 'BOQ V.2: 30 orang/kali x 10 bulan (Total 300 org-kali)',
    boqRef: 'V.2 Koordinasi Bulanan Fasilitator',
    copiesRequired: 1,
    discussionRequired: 'Team Leader, KorKot, AsMan & Tenaga Pendamping Lapangan',
    scopeItems: [
      'Koordinasi bulanan seluruh Tenaga Ahli, KorKot, AsMan, dan Tenaga Pendamping Lapangan',
      'Evaluasi capaian indikator bulanan dan konsolidasi pelaporan',
      'Penyusunan target kerja bulan berikutnya',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Rapat Koordinasi (.jpg / .png)',
      'Notula Rapat Koordinasi Tim Konsultan (.pdf)',
      'Daftar Hadir Fasilitator (.pdf)',
    ],
  },
  {
    id: 'boq_rapat_3_bulanan_bpbpk',
    category: 'kegiatan_boq',
    code: 'BOQ-V.3',
    isBoqActivity: true,
    title: 'Rapat 3 Bulanan Koordinasi dengan BPBPK Sumatera Barat (Triwulan 1, 2, 3)',
    subtitle: 'BOQ V.3: 30 orang/kali x 3 kali rapat (Total 90 org-kali)',
    boqRef: 'V.3 Rapat 3 Bulanan BPBPK',
    copiesRequired: 1,
    discussionRequired: 'Balai Penataan Bangunan Prasarana dan Kawasan (BPBPK) Sumbar',
    scopeItems: [
      'Penyampaian laporan progres triwulanan kepada BPBPK Sumbar',
      'Pemaparan evaluasi indikator kinerja proyek ISWMP Kota Padang',
      'Penyusunan Rencana Kerja Tindak Lanjut (RKTL) triwulan berikutnya',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Rapat BPBPK (.jpg / .png)',
      'Slide Bahan Paparan Rapat (.pptx / .pdf)',
      'Notula & Daftar Hadir Rapat BPBPK (.pdf)',
    ],
  },
  {
    id: 'boq_piloting_uji_coba_lapangan',
    category: 'kegiatan_boq',
    code: 'BOQ-C.1-C.2',
    isBoqActivity: true,
    title: 'Piloting / Uji Coba Pengumpulan Terpilah, Penggunaan Alat Angkut & APD, serta Pengolahan Organik',
    subtitle: 'BOQ C.1 & C.2: Uji coba motor sampah, troli, keranjang, tong organik, APD lengkap & 3 lokasi percontohan organik',
    boqRef: 'C.1 & C.2 Biaya Uji Coba (Piloting)',
    copiesRequired: 1,
    discussionRequired: 'Tim Pengelola TPS3R, Operator Pengolahan & Tim Pendamping',
    scopeItems: [
      'Dokumentasi penyerahan dan uji coba alat angkut manual (troli dorong, keranjang, sekop, drum organik 120L)',
      'Dokumentasi kelengkapan APD petugas (sarung tangan, masker, sepatu boots, rompi, helm)',
      'Uji coba operasional pengumpulan sampah terpilah dari rumah tangga ke TPS3R/titik kumpul',
      'Dokumentasi operasional pengolahan sampah organik di 3 lokasi percontohan kelurahan',
    ],
    requiredDeliverableOutputs: [
      'Foto Dokumentasi Uji Coba & Penyerahan Alat/APD (.jpg / .png)',
      'Video Dokumentasi Simulasi Pengumpulan & Pengolahan Organik (.mp4 / link)',
      'Berita Acara Uji Coba & Pemanfaatan Alat (.pdf)',
      'Laporan Hasil Piloting Lapangan (.pdf)',
    ],
  },
];

const LOCAL_STORAGE_KEY = 'iswmp_deliverables_cache';
export const MAX_DELIVERABLE_FILE_BYTES = 250 * 1024 * 1024;

const DELIVERABLE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
]);

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

const getLocalStorageKey = () => {
  const uid = auth?.currentUser?.uid;
  return uid ? `${LOCAL_STORAGE_KEY}:${uid}` : null;
};

const getLocalSubmissions = () => {
  try {
    const storageKey = getLocalStorageKey();
    if (!storageKey) return {};
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const saveLocalSubmissions = (data) => {
  try {
    const storageKey = getLocalStorageKey();
    if (!storageKey) return false;
    localStorage.setItem(storageKey, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
};

export const isUsableFirebaseStorage = (candidate) => Boolean(
  candidate?.app &&
  Number.isFinite(candidate.maxUploadRetryTime) &&
  Number.isFinite(candidate.maxOperationRetryTime)
);

export const resolveDeliverableContentType = (file) => {
  const declaredType = String(file?.type || '').trim().toLowerCase();
  if (DELIVERABLE_MIME_TYPES.has(declaredType)) {
    return declaredType;
  }

  const extension = String(file?.name || '').split('.').pop()?.toLowerCase();
  return MIME_BY_EXTENSION[extension] || '';
};

export const validateDeliverableFile = (file) => {
  if (!file || typeof file.name !== 'string' || file.name.trim().length === 0) {
    throw new Error('Berkas deliverable tidak valid.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('Berkas kosong tidak dapat diunggah.');
  }
  if (file.size > MAX_DELIVERABLE_FILE_BYTES) {
    throw new Error('Ukuran berkas deliverable maksimal 250 MB.');
  }

  const contentType = resolveDeliverableContentType(file);
  if (!contentType) {
    throw new Error('Jenis berkas ini tidak diizinkan untuk deliverable.');
  }
  return contentType;
};

export const getSafeHttpUrl = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
};

export const getYouTubeEmbedUrl = (value) => {
  const safeUrl = getSafeHttpUrl(value);
  if (!safeUrl) return null;

  const parsed = new URL(safeUrl);
  const host = parsed.hostname.toLowerCase();
  let videoId = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    videoId = parsed.pathname.split('/').filter(Boolean)[0] || null;
  } else if ([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
  ].includes(host)) {
    if (parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v');
    } else {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(parts[0])) {
        videoId = parts[1] || null;
      }
    }
  }

  return typeof videoId === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(videoId)
    ? `https://www.youtube-nocookie.com/embed/${videoId}`
    : null;
};

const validDeliverableStoragePath = (value) => (
  typeof value === 'string' &&
  /^deliverables\/[a-z0-9_]{1,100}\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(value)
);

export const sanitizePublicDeliverableFiles = (files) => (
  Array.isArray(files)
    ? files
      .filter((file) => validDeliverableStoragePath(file?.storagePath))
      .map((file) => ({
        name: String(file.name || '').slice(0, 255),
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0,
        type: String(file.type || '').slice(0, 200),
        storagePath: file.storagePath,
        uploadedAt: String(file.uploadedAt || '').slice(0, 64),
      }))
    : []
);

export const mergeDeliverableFiles = (latestFiles, uploadedFiles) => {
  const merged = Array.isArray(latestFiles) ? [...latestFiles] : [];
  const indexByPath = new Map();
  merged.forEach((file, index) => {
    if (validDeliverableStoragePath(file?.storagePath)) {
      indexByPath.set(file.storagePath, index);
    }
  });

  (Array.isArray(uploadedFiles) ? uploadedFiles : []).forEach((file) => {
    if (!validDeliverableStoragePath(file?.storagePath)) {
      throw new Error('Hasil upload berkas tidak memiliki path Storage yang valid.');
    }
    const existingIndex = indexByPath.get(file.storagePath);
    if (existingIndex === undefined) {
      indexByPath.set(file.storagePath, merged.length);
      merged.push(file);
    } else {
      merged[existingIndex] = file;
    }
  });

  return merged;
};

/** Tokenless URL: Storage rules are re-evaluated on every public request. */
export const getPublicDeliverableFileUrl = (file) => {
  if (!validDeliverableStoragePath(file?.storagePath)) return null;
  const bucket = storage?.app?.options?.storageBucket;
  if (typeof bucket !== 'string' || bucket.length === 0) return null;
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}` +
    `/o/${encodeURIComponent(file.storagePath)}?alt=media`;
};

const createPersistenceError = (cause, cachedLocally, offline = false) => {
  const localMessage = cachedLocally
    ? ' Salinan lokal tersimpan di perangkat ini dan belum tersinkron ke server.'
    : ' Salinan lokal juga tidak dapat disimpan.';
  const error = new Error(
    `${offline ? 'Perangkat sedang offline.' : 'Firestore menolak atau gagal menyimpan laporan.'}${localMessage}`,
    { cause }
  );
  error.code = offline
    ? 'deliverables/offline-local-only'
    : 'deliverables/remote-persistence-failed';
  error.cachedLocally = cachedLocally;
  return error;
};

export const requireRemoteDeliverablePersistence = async (
  writeOperation,
  { cachedLocally = false, offline = false } = {}
) => {
  if (offline) {
    throw createPersistenceError(null, cachedLocally, true);
  }
  try {
    await writeOperation();
  } catch (cause) {
    if (String(cause?.code || '').startsWith('deliverables/')) {
      throw cause;
    }
    throw createPersistenceError(cause, cachedLocally, false);
  }
};

const timestampMillis = (value) => {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const preferPendingLocalSubmission = (remoteSubmission, localSubmission) => {
  if (!localSubmission) return remoteSubmission;
  if (
    !remoteSubmission ||
    timestampMillis(localSubmission.lastUpdatedAt) >
      timestampMillis(remoteSubmission.lastUpdatedAt)
  ) {
    return { ...localSubmission, persistenceState: 'local-only' };
  }
  return remoteSubmission;
};

/**
 * Mengambil seluruh deliverables KAK dengan status submission terkini
 */
export const getAllDeliverables = async () => {
  const localData = getLocalSubmissions();
  let remoteData = {};

  try {
    const snapshot = await getDocs(collection(db, 'deliverables_submissions'));
    snapshot.forEach((docSnap) => {
      remoteData[docSnap.id] = docSnap.data();
    });
  } catch (err) {
    console.warn('Could not fetch remote deliverables, using local cache:', err);
  }

  return KAK_DELIVERABLES_CONFIG.map((config) => {
    const submission = preferPendingLocalSubmission(
      remoteData[config.id] || null,
      localData[config.id] || null
    );
    return {
      ...config,
      submission: submission || {
        status: 'draft',
        files: [],
        scopeChecklist: {},
        notes: '',
        submittedAt: null,
        submittedBy: null,
        registrationNumber: null,
        discussionDate: null,
        discussionNotes: '',
        driveUrl: '',
      },
    };
  });
};

/**
 * Mengambil detail deliverable KAK berdasarkan ID
 */
export const getDeliverableById = async (deliverableId) => {
  const config = KAK_DELIVERABLES_CONFIG.find((d) => d.id === deliverableId);
  if (!config) return null;

  let submission = null;
  const local = getLocalSubmissions();
  const signedIn = Boolean(auth?.currentUser?.uid);
  let privateReadSucceeded = false;

  if (signedIn) {
    try {
      const docSnap = await getDoc(doc(db, 'deliverables_submissions', deliverableId));
      privateReadSucceeded = true;
      if (docSnap.exists()) {
        submission = preferPendingLocalSubmission(
          docSnap.data(),
          local[deliverableId] || null
        );
      }
    } catch (err) {
      console.warn('Error reading private deliverable from Firestore:', err);
      submission = local[deliverableId]
        ? { ...local[deliverableId], persistenceState: 'local-only' }
        : null;
    }
  }

  if (!submission) {
    try {
      const publicSnap = await getDoc(doc(db, 'deliverables_public', deliverableId));
      if (publicSnap.exists()) {
        submission = publicSnap.data();
      }
    } catch (err) {
      if (!signedIn) {
        console.warn('Error reading published deliverable from Firestore:', err);
      }
    }
  }

  // An unauthenticated share link must never manufacture a public-looking
  // draft from the private hard-coded configuration alone.
  if ((!signedIn || !privateReadSucceeded) && !submission) {
    return null;
  }

  return {
    ...config,
    submission: submission || {
      status: 'draft',
      files: [],
      scopeChecklist: {},
      notes: '',
      submittedAt: null,
      submittedBy: null,
      registrationNumber: null,
      discussionDate: null,
      discussionNotes: '',
      driveUrl: '',
    },
  };
};

/**
 * Upload file berkas ke Firebase Storage dengan progress callback
 */
export const uploadDeliverableFile = async (
  deliverableId,
  file,
  onProgress = () => {}
) => {
  const config = KAK_DELIVERABLES_CONFIG.find((item) => item.id === deliverableId);
  if (!config) {
    throw new Error('ID deliverable tidak dikenal.');
  }
  if (!isUsableFirebaseStorage(storage)) {
    const error = new Error(
      'Firebase Storage tidak tersedia. Berkas tidak disimpan sebagai data lokal.'
    );
    error.code = 'deliverables/storage-unavailable';
    throw error;
  }

  const uploaderUid = auth?.currentUser?.uid;
  if (!uploaderUid) {
    const error = new Error('Sesi pengguna berakhir. Silakan masuk kembali sebelum mengunggah.');
    error.code = 'deliverables/auth-required';
    throw error;
  }

  const contentType = validateDeliverableFile(file);
  const uploadId = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}_${Math.random().toString(36).slice(2, 18)}`;
  const safeFileName = file.name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 140) || 'berkas';
  const storagePath = `deliverables/${deliverableId}/${uploadId}_${safeFileName}`;
  const reservationRef = doc(db, 'deliverable_uploadReservations', uploadId);

  await setDoc(reservationRef, {
    uploadId,
    deliverableId,
    storagePath,
    uploadedBy: uploaderUid,
    status: 'pending',
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
  });

  const storageRef = ref(storage, storagePath);
  const uploadTask = uploadBytesResumable(storageRef, file, {
    contentType,
    customMetadata: {
      deliverableId,
      uploadedBy: uploaderUid,
      uploadId,
    },
  });

  const uploadError = (cause) => {
    const error = new Error(cause?.message || 'Upload berkas gagal.', { cause });
    error.code = cause?.code || 'deliverables/upload-failed';
    error.storagePath = storagePath;
    error.uploadReservationId = uploadId;
    return error;
  };

  return new Promise((resolve, reject) => {
    uploadTask.on(
      'state_changed',
      (snapshot) => {
        const progress = snapshot.totalBytes > 0
          ? (snapshot.bytesTransferred / snapshot.totalBytes) * 100
          : 0;
        onProgress(Math.round(progress));
      },
      (error) => {
        console.error('Storage upload error:', error);
        reject(uploadError(error));
      },
      async () => {
        try {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
          resolve({
            name: file.name,
            size: file.size,
            type: contentType,
            url: downloadUrl,
            storagePath,
            uploadReservationId: uploadId,
            uploadedAt: new Date().toISOString(),
          });
        } catch (err) {
          reject(uploadError(err));
        }
      }
    );
  });
};

/** Best-effort cleanup for a just-uploaded file that was never committed. */
export const deleteUncommittedDeliverableFile = async (
  deliverableId,
  uploadedFile
) => {
  const storagePath = uploadedFile?.storagePath;
  const uploadReservationId = uploadedFile?.uploadReservationId;
  const expectedPrefix = `deliverables/${deliverableId}/`;
  if (
    typeof storagePath !== 'string' ||
    !storagePath.startsWith(expectedPrefix) ||
    storagePath.slice(expectedPrefix.length).includes('/') ||
    typeof uploadReservationId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(uploadReservationId)
  ) {
    throw new Error('Path cleanup deliverable tidak valid.');
  }
  try {
    await deleteObject(ref(storage, storagePath));
  } catch (error) {
    if (error?.code !== 'storage/object-not-found') throw error;
  }
  await deleteDoc(doc(
    db,
    'deliverable_uploadReservations',
    uploadReservationId
  ));
};

/**
 * Menyimpan atau mensubmit deliverable ke database
 */
export const buildDeliverableSubmissionPayload = (
  deliverableId,
  submissionPayload,
  user,
  userData,
  now = new Date()
) => {
  const config = KAK_DELIVERABLES_CONFIG.find((d) => d.id === deliverableId);
  if (!config) {
    throw new Error('ID deliverable tidak dikenal.');
  }
  if (!user?.uid) {
    const error = new Error('Sesi pengguna berakhir. Silakan masuk kembali sebelum menyimpan.');
    error.code = 'deliverables/auth-required';
    throw error;
  }
  if (!['draft', 'submitted', 'review', 'approved'].includes(submissionPayload?.status)) {
    throw new Error('Status deliverable tidak valid.');
  }

  const code = config.code || 'DOC';
  const year = now.getFullYear();
  const autoRegNumber =
    submissionPayload.registrationNumber ||
    `DOC-ISWMP-${code}/SAK/${year}`;

  const finalPayload = {
    ...submissionPayload,
    deliverableId,
    code,
    registrationNumber: autoRegNumber,
    lastUpdatedAt: now.toISOString(),
    updatedBy: {
      uid: user.uid,
      name: userData?.name || userData?.nama || user?.email || 'Misdar Putra (Team Leader)',
      email: user?.email || '',
      role: userData?.role || 'unknown',
    },
  };

  // A direct approval is also a publication and needs a submission timestamp.
  if (
    (finalPayload.status === 'submitted' || finalPayload.status === 'approved') &&
    !finalPayload.submittedAt
  ) {
    finalPayload.submittedAt = now.toISOString();
    finalPayload.submittedBy = finalPayload.updatedBy.name;
  }

  return finalPayload;
};

const deliverableSubmissionFields = (submission = {}) => ({
  status: submission.status || 'draft',
  registrationNumber: submission.registrationNumber || null,
  revision: Number.isInteger(submission.revision) ? submission.revision : 0,
  scopeChecklist: submission.scopeChecklist || {},
  notes: submission.notes || '',
  driveUrl: submission.driveUrl || '',
  videoUrl: submission.videoUrl || '',
  activityDate: submission.activityDate || '',
  activityLocation: submission.activityLocation || '',
  attendeesCount: submission.attendeesCount || '',
  speakers: submission.speakers || '',
  discussionDate: submission.discussionDate || '',
  discussionNotes: submission.discussionNotes || '',
  files: Array.isArray(submission.files) ? submission.files : [],
  submittedBy: submission.submittedBy || null,
  submittedAt: submission.submittedAt || null,
});

const withDeliverableStoragePaths = (payload) => {
  const publicFiles = sanitizePublicDeliverableFiles(payload.files);
  return {
    ...payload,
    storagePaths: publicFiles.map((file) => file.storagePath),
  };
};

export const buildOfflineDeliverableCache = (candidatePayload, serverRevision) => ({
  ...candidatePayload,
  revision: Number.isInteger(serverRevision) ? serverRevision : 0,
});

const buildPublicDeliverablePayload = (payload) => ({
  deliverableId: payload.deliverableId,
  code: payload.code,
  registrationNumber: payload.registrationNumber,
  status: payload.status,
  scopeChecklist: payload.scopeChecklist || {},
  videoUrl: payload.videoUrl || '',
  activityDate: payload.activityDate || '',
  activityLocation: payload.activityLocation || '',
  attendeesCount: payload.attendeesCount || '',
  speakers: payload.speakers || '',
  discussionDate: payload.discussionDate || '',
  discussionNotes: payload.discussionNotes || '',
  files: sanitizePublicDeliverableFiles(payload.files),
  storagePaths: payload.storagePaths || [],
  submittedBy: payload.submittedBy || '',
  submittedAt: payload.submittedAt || '',
  lastUpdatedAt: serverTimestamp(),
});

const reservationDetails = (files) => {
  const byId = new Map();
  (Array.isArray(files) ? files : []).forEach((file) => {
    const uploadId = file?.uploadReservationId;
    if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(uploadId)) {
      return;
    }
    const previous = byId.get(uploadId);
    if (previous && previous.storagePath !== file.storagePath) {
      throw new Error('Satu reservasi upload tidak boleh menunjuk ke dua path.');
    }
    byId.set(uploadId, file);
  });
  return [...byId.entries()].map(([uploadId, file]) => ({ uploadId, file }));
};

const assertDeliverableReservation = (
  snapshot,
  { uploadId, file },
  deliverableId,
  userUid,
  { requirePendingOwner = false } = {}
) => {
  const reservation = snapshot.exists() ? snapshot.data() : null;
  if (
    !reservation ||
    reservation.uploadId !== uploadId ||
    reservation.deliverableId !== deliverableId ||
    reservation.storagePath !== file.storagePath ||
    !['pending', 'committed'].includes(reservation.status) ||
    (requirePendingOwner && (
      reservation.uploadedBy !== userUid || reservation.status !== 'pending'
    )) ||
    (!requirePendingOwner && reservation.status === 'pending'
      && reservation.uploadedBy !== userUid)
  ) {
    const error = new Error(
      'Reservasi upload tidak lagi valid. Muat ulang dokumen dan unggah kembali.'
    );
    error.code = 'deliverables/upload-reservation-conflict';
    throw error;
  }
  return reservation;
};

export const saveDeliverableSubmission = async (
  deliverableId,
  submissionPayload,
  user,
  userData
) => {
  const expectedRevision = Number.isInteger(submissionPayload?.revision)
    ? submissionPayload.revision
    : 0;
  const candidatePayload = withDeliverableStoragePaths({
    ...buildDeliverableSubmissionPayload(
      deliverableId,
      submissionPayload,
      user,
      userData
    ),
    revision: expectedRevision + 1,
  });
  const privateRef = doc(db, 'deliverables_submissions', deliverableId);
  const publicRef = doc(db, 'deliverables_public', deliverableId);
  const explicitlyOffline =
    typeof navigator !== 'undefined' && navigator.onLine === false;

  if (explicitlyOffline) {
    const local = getLocalSubmissions();
    // Keep the server revision as the retry precondition. Incrementing it in
    // an offline-only cache would make the first online retry conflict with
    // the unchanged server document forever.
    local[deliverableId] = buildOfflineDeliverableCache(
      candidatePayload,
      expectedRevision
    );
    const cachedLocally = saveLocalSubmissions(local);
    throw createPersistenceError(null, cachedLocally, true);
  }

  let finalPayload;

  try {
    await requireRemoteDeliverablePersistence(async () => {
      finalPayload = await runTransaction(db, async (transaction) => {
        const currentSnapshot = await transaction.get(privateRef);
        const currentRevision = currentSnapshot.exists()
          && Number.isInteger(currentSnapshot.data().revision)
          ? currentSnapshot.data().revision
          : 0;
        if (
          (currentSnapshot.exists() && currentRevision !== expectedRevision) ||
          (!currentSnapshot.exists() && expectedRevision !== 0)
        ) {
          const error = new Error(
            'Dokumen telah diperbarui pengguna lain. Muat ulang sebelum menyimpan agar perubahan terbaru tidak tertimpa.'
          );
          error.code = 'deliverables/write-conflict';
          throw error;
        }

        transaction.set(privateRef, {
          ...candidatePayload,
          lastUpdatedAt: serverTimestamp(),
        });
        if (
          candidatePayload.status === 'submitted' ||
          candidatePayload.status === 'approved'
        ) {
          transaction.set(
            publicRef,
            buildPublicDeliverablePayload(candidatePayload)
          );
        } else {
          transaction.delete(publicRef);
        }
        return candidatePayload;
      });
    }, { cachedLocally: false, offline: false });
  } catch (error) {
    if (error?.code === 'deliverables/write-conflict') {
      // A stale offline snapshot must not win again on the next reload. The
      // current modal still retains the user's unsaved fields for copying.
      const local = getLocalSubmissions();
      delete local[deliverableId];
      saveLocalSubmissions(local);
    }
    throw error;
  }

  const local = getLocalSubmissions();
  local[deliverableId] = finalPayload;
  saveLocalSubmissions(local);
  return finalPayload;
};

/**
 * Commit freshly uploaded objects against the latest server document.
 * The transaction preserves concurrent form/status changes and appends only
 * the new files before atomically closing their upload reservations.
 */
export const commitDeliverableUploads = async (
  deliverableId,
  fallbackSubmission,
  uploadedFiles,
  user,
  userData
) => {
  if (!user?.uid) {
    const error = new Error('Sesi pengguna berakhir. Silakan masuk kembali.');
    error.code = 'deliverables/auth-required';
    throw error;
  }
  const details = reservationDetails(uploadedFiles);
  if (details.length !== uploadedFiles.length || details.length === 0) {
    throw new Error('Daftar hasil upload atau reservasinya tidak lengkap.');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw createPersistenceError(null, false, true);
  }

  const privateRef = doc(db, 'deliverables_submissions', deliverableId);
  const publicRef = doc(db, 'deliverables_public', deliverableId);
  let finalPayload;
  await requireRemoteDeliverablePersistence(async () => {
    finalPayload = await runTransaction(db, async (transaction) => {
      const currentSnapshot = await transaction.get(privateRef);
      const latestSubmission = currentSnapshot.exists()
        ? currentSnapshot.data()
        : fallbackSubmission || {};
      const currentRevision = currentSnapshot.exists()
        && Number.isInteger(currentSnapshot.data().revision)
        ? currentSnapshot.data().revision
        : 0;

      const reservations = [];
      for (const detail of details) {
        const reservationRef = doc(
          db,
          'deliverable_uploadReservations',
          detail.uploadId
        );
        const snapshot = await transaction.get(reservationRef);
        assertDeliverableReservation(
          snapshot,
          detail,
          deliverableId,
          user.uid,
          { requirePendingOwner: true }
        );
        reservations.push(reservationRef);
      }

      const mergedFiles = mergeDeliverableFiles(
        latestSubmission.files,
        uploadedFiles
      );
      finalPayload = withDeliverableStoragePaths({
        ...buildDeliverableSubmissionPayload(
          deliverableId,
          {
            ...deliverableSubmissionFields(latestSubmission),
            files: mergedFiles,
          },
          user,
          userData
        ),
        revision: currentRevision + 1,
      });

      transaction.set(privateRef, {
        ...finalPayload,
        lastUpdatedAt: serverTimestamp(),
      });
      if (finalPayload.status === 'submitted' || finalPayload.status === 'approved') {
        transaction.set(publicRef, buildPublicDeliverablePayload(finalPayload));
      } else {
        transaction.delete(publicRef);
      }
      reservations.forEach((reservationRef) => {
        transaction.update(reservationRef, {
            status: 'committed',
            committedAt: serverTimestamp(),
        });
      });
      return finalPayload;
    });
  });

  const local = getLocalSubmissions();
  local[deliverableId] = finalPayload;
  saveLocalSubmissions(local);
  return finalPayload;
};

/**
 * Menghasilkan link publik shareable untuk deliverable
 */
export const getDeliverableShareUrl = (deliverableId) => {
  const origin = window.location.origin || getAppUrl();
  return `${origin}/deliverables/view/${deliverableId}`;
};

/**
 * Format ukuran file ke string ramah baca (KB / MB)
 */
export const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

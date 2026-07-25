/**
 * Temporary operational attendance locations for location_photo mode.
 *
 * These are operator-declared coordinates, not dual-control audited
 * geofences. Records that match them remain location_photo_only.
 *
 * Source for BimTek venue: OpenStreetMap way 156348316 (Grand Zuri /
 * The ZHM Premiere Padang), Jl. M.H. Thamrin No. 27, Alang Laweh.
 * Window: 28 Jul 00:00 WIB through 1 Aug 00:00 WIB.
 */

export const TEMPORARY_ATTENDANCE_LOCATIONS = Object.freeze([
  Object.freeze({
    id: 'bimtek-zhm-premiere-padang-2026-07',
    nama: 'BimTek The ZHM Premiere Padang',
    alamat: 'Jl. M.H. Thamrin No. 27, Alang Laweh, Padang Selatan',
    lat: -0.9546883,
    lng: 100.3643174,
    radius: 150,
    validFrom: '2026-07-27T17:00:00.000Z',
    validUntil: '2026-07-31T17:00:00.000Z',
    coordinateSource: 'OpenStreetMap tourism=hotel (way/156348316)',
    coordinateSourceUrl:
      'https://www.openstreetmap.org/way/156348316',
    catatan:
      'Kegiatan BimTek seluruh tim 28-31 Juli 2026; lokasi sementara ' +
      'aditif terhadap penugasan asal di mode GPS + foto',
  }),
]);

const MAX_COLUMN_WIDTH = 36;
const MIN_COLUMN_WIDTH = 12;

const getCellText = (cell) => {
  if (cell == null) return '';
  if (typeof cell === 'object' && 'value' in cell) return String(cell.value ?? '');
  return String(cell);
};

export const getExcelColumns = (rows, preferredWidths = []) => {
  const columnCount = rows.reduce((largest, row) => Math.max(largest, row.length), 0);

  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const contentWidth = rows.reduce((largest, row) => (
      Math.max(largest, getCellText(row[columnIndex]).length)
    ), 0);
    const preferredWidth = preferredWidths[columnIndex] ?? MIN_COLUMN_WIDTH;

    return {
      width: Math.max(
        MIN_COLUMN_WIDTH,
        Math.min(MAX_COLUMN_WIDTH, Math.max(contentWidth + 2, preferredWidth))
      ),
    };
  });
};

export const createExcelHyperlink = (label, target) => {
  if (!target) return 'N/A';

  try {
    const url = new URL(target);
    if (url.protocol !== 'https:') return 'N/A';

    const escapedTarget = url.toString().replaceAll('"', '""');
    const escapedLabel = String(label).replaceAll('"', '""');
    return {
      type: 'Formula',
      value: `=HYPERLINK("${escapedTarget}","${escapedLabel}")`,
      textColor: '#0563C1',
      textDecoration: { underline: true },
    };
  } catch {
    return 'N/A';
  }
};

export const downloadExcelWorkbook = async (sheets, fileName) => {
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const workbook = sheets.map(({ data, preferredWidths, ...sheetOptions }) => ({
    ...sheetOptions,
    data,
    columns: getExcelColumns(data, preferredWidths),
  }));

  await writeExcelFile(workbook).toFile(fileName);
};

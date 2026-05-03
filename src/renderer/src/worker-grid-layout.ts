export interface WorkerGridLayout {
  cols: number;
  rows: number;
  featureFirst: boolean;
}

export function getWorkerGridLayout(count: number): WorkerGridLayout {
  if (count <= 1) return { cols: 1, rows: 1, featureFirst: false };

  switch (count) {
    case 2:
      return { cols: 2, rows: 1, featureFirst: false };
    case 3:
      return { cols: 2, rows: 2, featureFirst: true };
    case 4:
      return { cols: 2, rows: 2, featureFirst: false };
    case 5:
      return { cols: 3, rows: 2, featureFirst: true };
    case 6:
      return { cols: 3, rows: 2, featureFirst: false };
    case 7:
      return { cols: 4, rows: 2, featureFirst: true };
    case 8:
      return { cols: 4, rows: 2, featureFirst: false };
    case 9:
      return { cols: 3, rows: 3, featureFirst: false };
    case 10:
      return { cols: 5, rows: 2, featureFirst: false };
    case 11:
      return { cols: 4, rows: 3, featureFirst: true };
    case 12:
      return { cols: 4, rows: 3, featureFirst: false };
    default: {
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      return {
        cols,
        rows,
        featureFirst: cols * rows === count + 1 && rows > 1,
      };
    }
  }
}

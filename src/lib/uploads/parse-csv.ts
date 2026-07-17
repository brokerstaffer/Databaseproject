import Papa from "papaparse";

export interface ParseResult {
  headers: string[];
  preview: string[][];
  totalRows: number;
}

// Full parse — every data row (the streaming parseCSVFile below only keeps a preview).
export function parseCSVAllRows(file: File): Promise<{ headers: string[]; rows: string[][] }> {
  return new Promise((resolve, reject) => {
    const headers: string[] = [];
    const rows: string[][] = [];
    let isHeader = true;
    Papa.parse(file, {
      skipEmptyLines: true,
      step(results) {
        const row = results.data as string[];
        if (isHeader) {
          headers.push(...row);
          isHeader = false;
          return;
        }
        rows.push(row);
      },
      complete() {
        if (headers.length === 0) reject(new Error("CSV file is empty"));
        else resolve({ headers, rows });
      },
      error(err) {
        reject(err);
      },
    });
  });
}

export function parseCSVFile(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const headers: string[] = [];
    const preview: string[][] = [];
    let totalRows = 0;
    let isHeader = true;

    Papa.parse(file, {
      skipEmptyLines: true,
      step(results) {
        const row = results.data as string[];
        if (isHeader) {
          headers.push(...row);
          isHeader = false;
          return;
        }
        totalRows++;
        if (preview.length < 5) {
          preview.push(row);
        }
      },
      complete() {
        if (headers.length === 0) {
          reject(new Error("CSV file is empty"));
          return;
        }
        resolve({ headers, preview, totalRows });
      },
      error(err) {
        reject(err);
      },
    });
  });
}

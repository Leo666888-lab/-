import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import {
  OrderImportFileError,
  parseOrderImport,
  suggestOrderImportMapping,
  type OrderImportMapping,
} from "../src/lib/order-import.js";

type TestCell = string | number | null | { formula: string; result: string | number };

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function columnName(columnNumber: number): string {
  let value = columnNumber;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cellXml(cell: TestCell, rowNumber: number, columnNumber: number): string {
  if (cell === null) return "";
  const reference = `${columnName(columnNumber)}${rowNumber}`;
  if (typeof cell === "object") {
    return `<c r="${reference}"><f>${escapeXml(cell.formula)}</f><v>${escapeXml(String(cell.result))}</v></c>`;
  }
  if (typeof cell === "number") return `<c r="${reference}" t="n"><v>${cell}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
}

function makeXlsx(rows: TestCell[][], extraEntries: Zippable = {}): Buffer {
  const maximumColumns = Math.max(...rows.map((row) => row.length));
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => cellXml(cell, rowIndex + 1, columnIndex + 1)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <dimension ref="A1:${columnName(maximumColumns)}${rows.length}"/>
      <sheetData>${sheetRows}</sheetData>
    </worksheet>`;
  const files: Zippable = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      </Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="Orders" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      </Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <cellXfs count="1"><xf numFmtId="0"/></cellXfs>
      </styleSheet>`),
    ...extraEntries,
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

const STANDARD_HEADERS = [
  "往来单位",
  "订单号",
  "方向",
  "订货日期",
  "计划交货日期",
  "账期（月）",
  "币种",
  "商品名称",
  "数量",
  "单价",
];

function csv(lines: string[]): Buffer {
  return Buffer.from(lines.join("\n"), "utf8");
}

describe("order import mapping", () => {
  it("suggests common Chinese columns with one-based column numbers", () => {
    const suggested = suggestOrderImportMapping([
      "厂家",
      "采购单号",
      "下单日期",
      "预计到货日期",
      "付款周期（月）",
      "结算币种",
      "品名",
      "件数",
      "采购价",
    ]);

    expect(suggested.mapping).toMatchObject({
      partnerName: 1,
      orderNo: 2,
      orderDate: 3,
      plannedDeliveryDate: 4,
      settlementMonths: 5,
      currency: 6,
      itemDescription: 7,
      quantity: 8,
      unitPrice: 9,
    });
    expect(suggested.suggestions.every((item) => item.columnNumber >= 1)).toBe(true);
  });

  it("accepts an explicit mapping for non-standard headers", async () => {
    const mapping: OrderImportMapping = {
      partnerName: 1,
      orderNo: 2,
      direction: 3,
      orderDate: 4,
      itemDescription: 5,
      quantity: 6,
      unitPrice: 7,
    };
    const result = await parseOrderImport(csv([
      "A,B,C,D,E,F,G",
      "Custom Partner,CUSTOM-1,应收,2026-07-25,Chair,2,99.50",
    ]), { fileName: "custom.csv", mapping, autoMapHeaders: false });

    expect(result.validRowCount).toBe(1);
    expect(result.rows[0]?.values).toMatchObject({
      orderNo: "CUSTOM-1",
      direction: "receivable",
      unitPriceCents: 9_950,
      lineTotalCents: 19_900,
    });
  });

  it("returns headers and missing fields when incomplete mapping is explicitly allowed", async () => {
    const result = await parseOrderImport(csv([
      "商家,流水,日期,货物,件,价格",
      "义乌客商,CUSTOM-2,2026-07-25,餐椅,2,99.50",
    ]), { fileName: "inspect.csv", allowIncompleteMapping: true });

    expect(result).toMatchObject({
      headers: ["商家", "流水", "日期", "货物", "件", "价格"],
      mapping: {},
      suggestions: [],
      missingFields: ["partnerName", "orderNo", "orderDate", "itemDescription", "quantity", "unitPrice"],
      rows: [],
      validRowCount: 0,
      invalidRowCount: 0,
    });
  });

  it("decodes legacy GB18030 CSV without turning Chinese names into mojibake", async () => {
    const mapping: OrderImportMapping = {
      partnerName: 1,
      orderNo: 2,
      direction: 3,
      orderDate: 4,
      itemDescription: 5,
      quantity: 6,
      unitPrice: 7,
    };
    const legacyCsv = Buffer.concat([
      Buffer.from("A,B,C,D,E,F,G\n", "ascii"),
      Buffer.from([0xbf, 0xcd, 0xbb, 0xa7]), // "客户" in GB18030/GBK.
      Buffer.from(",GB-1,receivable,2026-07-25,Chair,1,88.00", "ascii"),
    ]);
    const result = await parseOrderImport(legacyCsv, {
      fileName: "legacy.csv",
      mapping,
      autoMapHeaders: false,
    });

    expect(result.encoding).toBe("gb18030");
    expect(result.rows[0]?.values.partnerName).toBe("客户");
  });
});

describe("CSV order import", () => {
  it("normalizes Chinese values, dates, currency, quantity, and exact cents", async () => {
    const result = await parseOrderImport(csv([
      STANDARD_HEADERS.join(","),
      "义乌家居客商,SO-2026-001,应收,2026/07/25,2026年8月2日,3个月,人民币,餐椅,2,\"1,234.50\"",
    ]), { fileName: "orders.csv" });

    expect(result).toMatchObject({ format: "csv", encoding: "utf-8", validRowCount: 1, invalidRowCount: 0 });
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      valid: true,
      values: {
        partnerName: "义乌家居客商",
        orderNo: "SO-2026-001",
        direction: "receivable",
        orderDate: "2026-07-25",
        plannedDeliveryDate: "2026-08-02",
        settlementMonths: 3,
        currency: "CNY",
        itemDescription: "餐椅",
        quantity: 2,
        unitPriceCents: 123_450,
        lineTotalCents: 246_900,
      },
    });
  });

  it("infers payable from a supplier header and preserves source row numbers across blanks", async () => {
    const result = await parseOrderImport(csv([
      "供应商名称,订单号,订货日期,商品,数量,单价",
      "永康五金厂,PO-001,2026-07-20,桌脚,4,35",
      "",
      "东阳木业,PO-002,20260721,桌面,1,680.00",
    ]), { fileName: "suppliers.csv" });

    expect(result.rows.map((row) => row.rowNumber)).toEqual([2, 4]);
    expect(result.rows.every((row) => row.values.direction === "payable")).toBe(true);
    expect(result.rows.every((row) => row.values.currency === "CNY")).toBe(true);
  });

  it("returns row-level formula, date, integer, precision, and duplicate errors", async () => {
    const result = await parseOrderImport(csv([
      STANDARD_HEADERS.join(","),
      "=1+1,DUP-1,应收,2026-02-30,2026-02-28,3,CNY,餐椅,0,10.001",
      "正常客户,DUP-1,应收,2026-02-28,2026-03-01,3,CNY,餐椅,1,10.00",
    ]), { fileName: "invalid.csv" });

    expect(result.invalidRowCount).toBe(2);
    expect(result.rows[0]?.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      "FORMULA_NOT_ALLOWED",
      "INVALID_DATE",
      "INVALID_INTEGER",
      "AMOUNT_PRECISION",
    ]));
    expect(result.rows[1]?.errors).toContainEqual(expect.objectContaining({
      code: "DUPLICATE_ORDER_NO",
      field: "orderNo",
    }));
  });

  it("checks imported order numbers against an existing set", async () => {
    const result = await parseOrderImport(csv([
      "客户名称,订单号,订货日期,商品,数量,单价",
      "老客户,EXISTING-001,2026-07-25,沙发,1,5000",
    ]), {
      fileName: "existing.csv",
      existingOrderNumbers: new Set(["EXISTING-001"]),
    });

    expect(result.rows[0]?.errors).toContainEqual(expect.objectContaining({ code: "ORDER_NO_ALREADY_EXISTS" }));
  });

  it("enforces configurable lower file and row limits", async () => {
    await expect(parseOrderImport(Buffer.from("123456"), {
      fileName: "small.csv",
      limits: { maxFileBytes: 5 },
    })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    await expect(parseOrderImport(csv([
      "客户名称,订单号,订货日期,商品,数量,单价",
      "客户一,A-1,2026-07-25,椅子,1,10",
      "客户二,A-2,2026-07-25,椅子,1,10",
    ]), {
      fileName: "too-many.csv",
      limits: { maxRows: 1 },
    })).rejects.toMatchObject({ code: "TOO_MANY_ROWS" });
  });
});

describe("XLSX order import", () => {
  it("parses the first worksheet without losing decimal precision", async () => {
    const workbook = makeXlsx([
      STANDARD_HEADERS,
      ["迪拜客户", "DXB-001", "应收", "2026-07-25", "2026-08-25", 3, "AED", "展示柜", 3, 12.34],
    ]);
    const result = await parseOrderImport(workbook, { fileName: "orders.xlsx" });

    expect(result).toMatchObject({ format: "xlsx", validRowCount: 1, invalidRowCount: 0 });
    expect(result.rows[0]?.values).toMatchObject({
      direction: "receivable",
      currency: "AED",
      quantity: 3,
      unitPriceCents: 1_234,
      lineTotalCents: 3_702,
    });
  });

  it("rejects native workbook formulas before parsing cached values", async () => {
    const workbook = makeXlsx([
      STANDARD_HEADERS,
      ["公式客户", "FORMULA-1", "应收", "2026-07-25", "2026-08-25", 3, "CNY", "桌子", 1, {
        formula: "1+1",
        result: 2,
      }],
    ]);

    await expect(parseOrderImport(workbook, { fileName: "formula.xlsx" })).rejects.toMatchObject({
      code: "FORMULA_NOT_ALLOWED",
    });
  });

  it("rejects suspicious compression ratios before workbook parsing", async () => {
    const workbook = makeXlsx([
      ["客户名称", "订单号", "订货日期", "商品", "数量", "单价"],
      ["客户", "ZIP-1", "2026-07-25", "椅子", 1, 10],
    ], {
      "xl/media/repeated.bin": new Uint8Array(2 * 1024 * 1024),
    });

    await expect(parseOrderImport(workbook, { fileName: "bomb.xlsx" })).rejects.toMatchObject({
      code: "ZIP_BOMB_DETECTED",
    });
  });

  it("rejects macro-bearing workbooks even when renamed to xlsx", async () => {
    const workbook = makeXlsx([
      ["客户名称", "订单号", "订货日期", "商品", "数量", "单价"],
      ["客户", "MACRO-1", "2026-07-25", "椅子", 1, 10],
    ], {
      "xl/vbaProject.bin": strToU8("not-executable-test-data"),
    });

    await expect(parseOrderImport(workbook, { fileName: "macro.xlsx" })).rejects.toMatchObject({
      code: "INVALID_XLSX",
    });
  });
});

describe("file-level validation", () => {
  it("uses stable typed errors for unsupported files and missing mappings", async () => {
    await expect(parseOrderImport(Buffer.from("anything"), { fileName: "orders.xls" })).rejects.toBeInstanceOf(
      OrderImportFileError,
    );
    await expect(parseOrderImport(Buffer.from("anything"), { fileName: "orders.xls" })).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });

    await expect(parseOrderImport(csv([
      "random,columns",
      "value,other",
    ]), { fileName: "unmapped.csv" })).rejects.toMatchObject({ code: "MISSING_REQUIRED_COLUMNS" });
  });
});

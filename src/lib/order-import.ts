import { parse as parseCsv } from "csv-parse/sync";
import { unzipSync } from "fflate";
import { readSheet } from "read-excel-file/universal";

export const ORDER_IMPORT_FIELDS = [
  "partnerName",
  "orderNo",
  "direction",
  "orderDate",
  "plannedDeliveryDate",
  "settlementMonths",
  "currency",
  "itemDescription",
  "quantity",
  "unitPrice",
] as const;

export type OrderImportField = (typeof ORDER_IMPORT_FIELDS)[number];
export type OrderImportDirection = "receivable" | "payable";
export type OrderImportFormat = "xlsx" | "csv";

export interface OrderImportLimits {
  maxFileBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellCharacters: number;
  maxZipEntries: number;
  maxZipEntryBytes: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const ORDER_IMPORT_LIMITS: Readonly<OrderImportLimits> = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 10_000,
  maxColumns: 100,
  maxCellCharacters: 10_000,
  maxZipEntries: 2_048,
  maxZipEntryBytes: 32 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
});

/** Mapping values are one-based spreadsheet column numbers. */
export type OrderImportMapping = Partial<Record<OrderImportField, number>>;

export interface OrderImportMappingSuggestion {
  field: OrderImportField;
  header: string;
  columnNumber: number;
  confidence: "exact" | "alias";
}

export interface OrderImportRowError {
  code: string;
  message: string;
  field?: OrderImportField;
  columnNumber?: number;
}

export interface NormalizedOrderImportValues {
  partnerName: string | null;
  orderNo: string | null;
  direction: OrderImportDirection | null;
  orderDate: string | null;
  plannedDeliveryDate: string | null;
  settlementMonths: number;
  currency: string;
  itemDescription: string | null;
  quantity: number | null;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
}

export interface OrderImportRow {
  rowNumber: number;
  values: NormalizedOrderImportValues;
  errors: OrderImportRowError[];
  valid: boolean;
}

export interface OrderImportResult {
  format: OrderImportFormat;
  encoding?: "utf-8" | "gb18030";
  headers: string[];
  mapping: OrderImportMapping;
  suggestions: OrderImportMappingSuggestion[];
  missingFields: OrderImportField[];
  rows: OrderImportRow[];
  validRowCount: number;
  invalidRowCount: number;
}

export interface ParseOrderImportOptions {
  fileName?: string;
  format?: OrderImportFormat;
  mapping?: OrderImportMapping;
  autoMapHeaders?: boolean;
  allowIncompleteMapping?: boolean;
  existingOrderNumbers?: Iterable<string>;
  limits?: Partial<OrderImportLimits>;
}

export type OrderImportFileErrorCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "INVALID_CSV_ENCODING"
  | "INVALID_CSV"
  | "INVALID_XLSX"
  | "ZIP_LIMIT_EXCEEDED"
  | "ZIP_BOMB_DETECTED"
  | "FORMULA_NOT_ALLOWED"
  | "TOO_MANY_ROWS"
  | "TOO_MANY_COLUMNS"
  | "CELL_TOO_LARGE"
  | "HEADER_REQUIRED"
  | "NO_DATA_ROWS"
  | "INVALID_LIMITS"
  | "INVALID_MAPPING"
  | "MISSING_REQUIRED_COLUMNS";

export class OrderImportFileError extends Error {
  constructor(
    public readonly code: OrderImportFileErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OrderImportFileError";
  }
}

const REQUIRED_FIELDS: readonly OrderImportField[] = [
  "partnerName",
  "orderNo",
  "orderDate",
  "itemDescription",
  "quantity",
  "unitPrice",
];

const PRIMARY_HEADERS: Record<OrderImportField, string> = {
  partnerName: "客户/供应商名称",
  orderNo: "订单号",
  direction: "方向",
  orderDate: "订货日期",
  plannedDeliveryDate: "计划交货日期",
  settlementMonths: "账期月数",
  currency: "币种",
  itemDescription: "商品",
  quantity: "数量",
  unitPrice: "单价",
};

const HEADER_ALIASES: Record<OrderImportField, readonly string[]> = {
  partnerName: [
    "客户/供应商名称", "客户供应商名称", "往来单位", "往来单位名称", "客户名称", "客户名", "买家",
    "采购商", "收货方", "供应商名称", "供应商", "供货商", "厂家", "厂商", "卖家", "partner",
    "partner name", "customer", "customer name", "supplier", "supplier name", "vendor", "vendor name",
  ],
  orderNo: [
    "订单号", "订单编号", "单号", "合同号", "客户订单号", "采购单号", "销售单号", "order no",
    "order number", "order id", "po no", "po number",
  ],
  direction: [
    "方向", "收付方向", "应收应付", "业务方向", "往来方向", "direction", "payment direction",
    "receivable/payable",
  ],
  orderDate: [
    "订货日期", "订单日期", "下单日期", "开单日期", "签单日期", "order date", "ordered at",
  ],
  plannedDeliveryDate: [
    "计划交货日期", "预计交货日期", "交货日期", "计划到货日期", "预计到货日期", "到货日期", "出货日期",
    "planned delivery date", "delivery date", "expected delivery date",
  ],
  settlementMonths: [
    "账期月数", "账期(月)", "账期（月）", "月结账期", "付款周期(月)", "付款周期（月）", "settlement months",
    "credit months", "payment term months",
  ],
  currency: ["币种", "货币", "结算币种", "currency", "currency code"],
  itemDescription: [
    "商品", "商品名称", "品名", "产品", "产品名称", "货品", "货品名称", "货号", "item", "item name",
    "product", "product name", "description",
  ],
  quantity: ["数量", "件数", "采购数量", "销售数量", "qty", "quantity"],
  unitPrice: ["单价", "含税单价", "未税单价", "销售单价", "采购单价", "销售价", "采购价", "unit price", "price"],
};

const RECEIVABLE_PARTNER_HEADERS = new Set([
  "客户名称", "客户名", "买家", "采购商", "收货方", "customer", "customername",
].map(normalizeHeader));

const PAYABLE_PARTNER_HEADERS = new Set([
  "供应商名称", "供应商", "供货商", "厂家", "厂商", "卖家", "supplier", "suppliername", "vendor", "vendorname",
].map(normalizeHeader));

const FIELD_SET = new Set<string>(ORDER_IMPORT_FIELDS);
const MAX_PARTNER_NAME = 200;
const MAX_ORDER_NO = 100;
const MAX_ITEM_DESCRIPTION = 500;
const MAX_QUANTITY = 10_000_000;
const MAX_SETTLEMENT_MONTHS = 120;
const MAX_UNIT_PRICE_CENTS = 9_000_000_000;
const FORMULA_PREFIX = /^\s*[=+\-@]/u;
const RECEIVABLE_DIRECTION_VALUES = new Set([
  "应收", "应收款", "应收账款", "收款", "销售", "客户", "receivable", "ar", "sale", "sales",
].map(normalizeHeader));
const PAYABLE_DIRECTION_VALUES = new Set([
  "应付", "应付款", "应付账款", "付款", "采购", "供应商", "payable", "ap", "purchase", "purchasing",
].map(normalizeHeader));
const CURRENCY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  人民币: "CNY",
  rmb: "CNY",
  "¥": "CNY",
  "￥": "CNY",
  美元: "USD",
  "$": "USD",
  欧元: "EUR",
  "€": "EUR",
  英镑: "GBP",
  "£": "GBP",
  日元: "JPY",
  迪拉姆: "AED",
  里亚尔: "SAR",
});

interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

function normalizeHeader(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_\-—–/\\()（）【】\[\].,，:：*]+/gu, "");
}

function normalizeBusinessText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function isFormulaLike(value: string): boolean {
  return FORMULA_PREFIX.test(value.normalize("NFKC"));
}

function isEmptyCell(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function isEmptyRow(row: readonly unknown[]): boolean {
  return row.every(isEmptyCell);
}

function fileError(
  code: OrderImportFileErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new OrderImportFileError(code, message, details);
}

function resolveLimits(overrides: Partial<OrderImportLimits> | undefined): OrderImportLimits {
  const resolved = {} as OrderImportLimits;
  for (const key of Object.keys(ORDER_IMPORT_LIMITS) as Array<keyof OrderImportLimits>) {
    const requested = overrides?.[key] ?? ORDER_IMPORT_LIMITS[key];
    if (!Number.isFinite(requested) || requested < 1) {
      fileError("INVALID_LIMITS", `导入限制 ${key} 必须是正数`);
    }
    resolved[key] = Math.min(Math.floor(requested), ORDER_IMPORT_LIMITS[key]);
  }
  return resolved;
}

function inferFormat(buffer: Buffer, options: ParseOrderImportOptions): OrderImportFormat {
  if (options.format) return options.format;
  const extension = options.fileName?.match(/\.([^.]+)$/u)?.[1]?.toLocaleLowerCase("en-US");
  if (extension === "xlsx") return "xlsx";
  if (extension === "csv") return "csv";
  if (extension) fileError("UNSUPPORTED_FORMAT", "仅支持 .xlsx 和 .csv 文件");
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return "xlsx";
  return "csv";
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function decodeZipEntryName(buffer: Buffer, start: number, length: number, utf8: boolean): string {
  const bytes = buffer.subarray(start, start + length);
  try {
    return utf8
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : bytes.toString("latin1");
  } catch {
    fileError("INVALID_XLSX", "XLSX 内含无效文件名编码");
  }
}

function inspectZipArchive(buffer: Buffer, limits: OrderImportLimits): ZipEntryInfo[] {
  const endOffset = findEndOfCentralDirectory(buffer);
  if (endOffset < 0) fileError("INVALID_XLSX", "XLSX 不是有效的 ZIP 文件");
  if (endOffset + 22 > buffer.length) fileError("INVALID_XLSX", "XLSX 中央目录不完整");

  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fileError("INVALID_XLSX", "不支持分卷 ZIP 文件");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fileError("ZIP_LIMIT_EXCEEDED", "不支持 ZIP64 格式的导入文件");
  }
  if (entryCount === 0 || entryCount > limits.maxZipEntries) {
    fileError("ZIP_LIMIT_EXCEEDED", `XLSX 压缩条目不能超过 ${limits.maxZipEntries} 个`);
  }
  if (endOffset + 22 + commentLength > buffer.length || centralOffset + centralSize > endOffset) {
    fileError("INVALID_XLSX", "XLSX 中央目录边界无效");
  }

  const entries: ZipEntryInfo[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== 0x02014b50) {
      fileError("INVALID_XLSX", "XLSX 中央目录条目无效");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (nextOffset > endOffset || localHeaderOffset >= centralOffset) {
      fileError("INVALID_XLSX", "XLSX 条目边界无效");
    }
    if ((flags & 0x0001) !== 0) fileError("INVALID_XLSX", "不支持加密的 XLSX 文件");
    if (diskStart !== 0 || localHeaderOffset === 0xffffffff) {
      fileError("INVALID_XLSX", "不支持分卷或 ZIP64 条目");
    }
    if (compression !== 0 && compression !== 8) {
      fileError("INVALID_XLSX", "XLSX 使用了不支持的压缩算法");
    }

    const name = decodeZipEntryName(buffer, offset + 46, nameLength, (flags & 0x0800) !== 0);
    const normalizedName = name.replace(/\\/gu, "/");
    const lowerName = normalizedName.toLocaleLowerCase("en-US");
    if (
      name.includes("\\")
      || normalizedName.startsWith("/")
      || normalizedName.split("/").includes("..")
      || normalizedName.includes("\0")
    ) {
      fileError("INVALID_XLSX", "XLSX 内含不安全的文件路径");
    }
    if (names.has(lowerName)) fileError("INVALID_XLSX", "XLSX 内含重复文件条目");
    names.add(lowerName);
    if (
      lowerName.endsWith("/vbaproject.bin")
      || lowerName.includes("/macrosheets/")
      || lowerName.includes("/activex/")
    ) {
      fileError("INVALID_XLSX", "不支持包含宏或 ActiveX 的工作簿");
    }
    if (uncompressedSize > limits.maxZipEntryBytes) {
      fileError("ZIP_LIMIT_EXCEEDED", `XLSX 单个解压条目不能超过 ${limits.maxZipEntryBytes} 字节`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      fileError("ZIP_LIMIT_EXCEEDED", `XLSX 解压总量不能超过 ${limits.maxUncompressedBytes} 字节`);
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      fileError("ZIP_BOMB_DETECTED", "XLSX 压缩比例异常");
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      fileError("ZIP_BOMB_DETECTED", `XLSX 压缩比例不能超过 ${limits.maxCompressionRatio}:1`);
    }

    entries.push({ name: normalizedName, compressedSize, uncompressedSize });
    offset = nextOffset;
  }

  if (offset !== centralOffset + centralSize) fileError("INVALID_XLSX", "XLSX 中央目录大小不一致");
  for (const required of ["[content_types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]) {
    if (!names.has(required)) fileError("INVALID_XLSX", `XLSX 缺少必要条目 ${required}`);
  }
  return entries;
}

function columnLettersToNumber(letters: string): number {
  let value = 0;
  for (const character of letters.toLocaleUpperCase("en-US")) {
    const code = character.charCodeAt(0) - 64;
    if (code < 1 || code > 26) return Number.POSITIVE_INFINITY;
    value = value * 26 + code;
  }
  return value;
}

function validateWorksheetXml(name: string, xml: string, limits: OrderImportLimits): void {
  const maximumSheetRow = limits.maxRows + 1;
  let rowTagCount = 0;
  const rowTagPattern = /<(?:[\w.-]+:)?row(?:\s|>)/giu;
  while (rowTagPattern.exec(xml)) {
    rowTagCount += 1;
    if (rowTagCount > maximumSheetRow) {
      fileError("TOO_MANY_ROWS", `工作表数据不能超过 ${limits.maxRows} 行`, { entry: name });
    }
  }

  const referencePattern = /\br=(?:"|')\$?([A-Z]+)\$?(\d+)(?:"|')/giu;
  for (let match = referencePattern.exec(xml); match; match = referencePattern.exec(xml)) {
    const columnNumber = columnLettersToNumber(match[1] ?? "");
    const rowNumber = Number(match[2]);
    if (columnNumber > limits.maxColumns) {
      fileError("TOO_MANY_COLUMNS", `工作表不能超过 ${limits.maxColumns} 列`, { entry: name });
    }
    if (rowNumber > maximumSheetRow) {
      fileError("TOO_MANY_ROWS", `工作表数据不能超过 ${limits.maxRows} 行`, { entry: name });
    }
  }

  const dimension = /<(?:[\w.-]+:)?dimension\b[^>]*\bref=(?:"|')([^"']+)(?:"|')[^>]*>/iu.exec(xml)?.[1];
  const finalReference = dimension?.split(":").at(-1);
  const dimensionMatch = /^\$?([A-Z]+)\$?(\d+)$/iu.exec(finalReference ?? "");
  if (dimensionMatch) {
    if (columnLettersToNumber(dimensionMatch[1] ?? "") > limits.maxColumns) {
      fileError("TOO_MANY_COLUMNS", `工作表不能超过 ${limits.maxColumns} 列`, { entry: name });
    }
    if (Number(dimensionMatch[2]) > maximumSheetRow) {
      fileError("TOO_MANY_ROWS", `工作表数据不能超过 ${limits.maxRows} 行`, { entry: name });
    }
  }
}

function inspectXlsxXml(buffer: Buffer, limits: OrderImportLimits): void {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buffer, {
      filter: (entry) => /\.xml(?:\.rels)?$/iu.test(entry.name),
    });
  } catch {
    fileError("INVALID_XLSX", "XLSX 解压失败");
  }

  let extractedBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [name, contents] of Object.entries(files)) {
    extractedBytes += contents.byteLength;
    if (extractedBytes > limits.maxUncompressedBytes) {
      fileError("ZIP_LIMIT_EXCEEDED", `XLSX 解压总量不能超过 ${limits.maxUncompressedBytes} 字节`);
    }
    if (contents.includes(0)) fileError("INVALID_XLSX", "XLSX XML 必须使用 UTF-8 编码");
    let xml: string;
    try {
      xml = decoder.decode(contents);
    } catch {
      fileError("INVALID_XLSX", "XLSX XML 含无效 UTF-8 字符");
    }
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fileError("INVALID_XLSX", "XLSX XML 不允许声明外部实体");
    if (/<(?:[\w.-]+:)?worksheet(?:\s|>)/iu.test(xml)) {
      if (/<(?:[\w.-]+:)?f(?:\s|\/?>)/iu.test(xml)) {
        fileError("FORMULA_NOT_ALLOWED", "导入文件不能包含公式，请先粘贴为数值", { entry: name });
      }
      validateWorksheetXml(name, xml, limits);
    }
  }
}

function preflightCsv(text: string, limits: OrderImportLimits): void {
  let inQuotes = false;
  let columnCount = 1;
  let recordCount = 1;
  let cellCharacters = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"") {
      if (inQuotes && text[index + 1] === "\"") {
        index += 1;
        cellCharacters += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && character === ",") {
      columnCount += 1;
      cellCharacters = 0;
      if (columnCount > limits.maxColumns) {
        fileError("TOO_MANY_COLUMNS", `CSV 不能超过 ${limits.maxColumns} 列`);
      }
      continue;
    }
    if (!inQuotes && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      recordCount += 1;
      columnCount = 1;
      cellCharacters = 0;
      if (recordCount > limits.maxRows + 2) {
        fileError("TOO_MANY_ROWS", `CSV 数据不能超过 ${limits.maxRows} 行`);
      }
      continue;
    }
    cellCharacters += 1;
    if (cellCharacters > limits.maxCellCharacters) {
      fileError("CELL_TOO_LARGE", `单元格不能超过 ${limits.maxCellCharacters} 个字符`);
    }
  }
  if (inQuotes) fileError("INVALID_CSV", "CSV 引号未闭合");
}

function decodeCsv(buffer: Buffer): { text: string; encoding: "utf-8" | "gb18030" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8" };
  } catch {
    try {
      return { text: new TextDecoder("gb18030", { fatal: true }).decode(buffer), encoding: "gb18030" };
    } catch {
      fileError("INVALID_CSV_ENCODING", "CSV 必须使用 UTF-8 或 GB18030 编码");
    }
  }
}

async function readImportTable(
  buffer: Buffer,
  format: OrderImportFormat,
  limits: OrderImportLimits,
): Promise<{ rows: unknown[][]; encoding?: "utf-8" | "gb18030" }> {
  if (format === "csv") {
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) fileError("INVALID_CSV", "文件内容是 XLSX，不是 CSV");
    const decoded = decodeCsv(buffer);
    preflightCsv(decoded.text, limits);
    try {
      const rows = parseCsv(decoded.text, {
        bom: true,
        relax_column_count: true,
        skip_empty_lines: false,
        max_record_size: limits.maxColumns * (limits.maxCellCharacters + 1),
        to: limits.maxRows + 2,
      });
      if (rows.length > limits.maxRows + 1) {
        fileError("TOO_MANY_ROWS", `CSV 数据不能超过 ${limits.maxRows} 行`);
      }
      return { rows, encoding: decoded.encoding };
    } catch (error) {
      if (error instanceof OrderImportFileError) throw error;
      fileError("INVALID_CSV", "CSV 格式无效");
    }
  }

  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) fileError("INVALID_XLSX", "文件内容不是有效的 XLSX");
  inspectZipArchive(buffer, limits);
  inspectXlsxXml(buffer, limits);
  try {
    const arrayBuffer = Uint8Array.from(buffer).buffer;
    const rows = await readSheet<string>(arrayBuffer, {
      trim: false,
      parseNumber: (value) => value,
    });
    if (rows.length > limits.maxRows + 1) {
      fileError("TOO_MANY_ROWS", `工作表数据不能超过 ${limits.maxRows} 行`);
    }
    return { rows: rows as unknown[][] };
  } catch (error) {
    if (error instanceof OrderImportFileError) throw error;
    fileError("INVALID_XLSX", "无法读取 XLSX 的第一个工作表");
  }
}

function aliasCandidates(headers: readonly string[]): OrderImportMappingSuggestion[] {
  const aliasLookup = new Map<string, { field: OrderImportField; exact: boolean }>();
  for (const field of ORDER_IMPORT_FIELDS) {
    const primary = normalizeHeader(PRIMARY_HEADERS[field]);
    for (const alias of HEADER_ALIASES[field]) {
      const normalized = normalizeHeader(alias);
      const candidate = { field, exact: normalized === primary };
      const existing = aliasLookup.get(normalized);
      if (!existing || candidate.exact) aliasLookup.set(normalized, candidate);
    }
  }

  const candidates: OrderImportMappingSuggestion[] = [];
  headers.forEach((header, index) => {
    const candidate = aliasLookup.get(normalizeHeader(header));
    if (!candidate) return;
    candidates.push({
      field: candidate.field,
      header,
      columnNumber: index + 1,
      confidence: candidate.exact ? "exact" : "alias",
    });
  });
  return candidates;
}

export function suggestOrderImportMapping(headers: readonly string[]): {
  mapping: OrderImportMapping;
  suggestions: OrderImportMappingSuggestion[];
} {
  const candidates = aliasCandidates(headers).sort((left, right) => {
    const confidenceDifference = Number(right.confidence === "exact") - Number(left.confidence === "exact");
    return confidenceDifference || left.columnNumber - right.columnNumber;
  });
  const mapping: OrderImportMapping = {};
  const suggestions: OrderImportMappingSuggestion[] = [];
  for (const candidate of candidates) {
    if (mapping[candidate.field] !== undefined) continue;
    mapping[candidate.field] = candidate.columnNumber;
    suggestions.push(candidate);
  }
  suggestions.sort((left, right) => left.columnNumber - right.columnNumber);
  return { mapping, suggestions };
}

function resolveMapping(
  headers: readonly string[],
  explicit: OrderImportMapping | undefined,
  autoMapHeaders: boolean,
  allowIncomplete: boolean,
): {
  mapping: OrderImportMapping;
  suggestions: OrderImportMappingSuggestion[];
  missingFields: OrderImportField[];
} {
  const suggested = suggestOrderImportMapping(headers);
  const mapping: OrderImportMapping = autoMapHeaders ? { ...suggested.mapping } : {};
  for (const [field, columnNumber] of Object.entries(explicit ?? {})) {
    if (!FIELD_SET.has(field)) fileError("INVALID_MAPPING", `未知导入字段 ${field}`);
    if (!Number.isInteger(columnNumber) || columnNumber < 1 || columnNumber > headers.length) {
      fileError("INVALID_MAPPING", `${field} 映射的列号无效`);
    }
    mapping[field as OrderImportField] = columnNumber;
  }

  const usedColumns = new Map<number, OrderImportField>();
  for (const field of ORDER_IMPORT_FIELDS) {
    const columnNumber = mapping[field];
    if (columnNumber === undefined) continue;
    const previous = usedColumns.get(columnNumber);
    if (previous) fileError("INVALID_MAPPING", `${previous} 和 ${field} 不能映射到同一列`);
    usedColumns.set(columnNumber, field);
  }
  const missingFields = REQUIRED_FIELDS.filter((field) => mapping[field] === undefined);
  if (missingFields.length > 0 && !allowIncomplete) {
    fileError("MISSING_REQUIRED_COLUMNS", `缺少必填列映射：${missingFields.join(", ")}`, {
      fields: missingFields,
    });
  }
  return { mapping, suggestions: suggested.suggestions, missingFields };
}

function directionHintFromPartnerHeader(header: string | undefined): OrderImportDirection | undefined {
  if (!header) return undefined;
  const normalized = normalizeHeader(header);
  if (RECEIVABLE_PARTNER_HEADERS.has(normalized)) return "receivable";
  if (PAYABLE_PARTNER_HEADERS.has(normalized)) return "payable";
  return undefined;
}

function directionFromValue(value: string): OrderImportDirection | undefined {
  const normalized = normalizeHeader(value);
  if (RECEIVABLE_DIRECTION_VALUES.has(normalized)) return "receivable";
  if (PAYABLE_DIRECTION_VALUES.has(normalized)) return "payable";
  return undefined;
}

function normalizedCellText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeBusinessText(value);
  return normalized === "" ? undefined : normalized;
}

function parseCalendarDate(value: unknown): string | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return value.toISOString().slice(0, 10);
  }
  const text = normalizedCellText(value);
  if (!text) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})$/u.exec(text);
  const separated = /^(\d{4})\s*(?:-|\/|\.|年)\s*(\d{1,2})\s*(?:-|\/|\.|月)\s*(\d{1,2})\s*日?$/u.exec(text);
  const match = compact ?? separated;
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseNonNegativeInteger(value: unknown, maximum: number, allowMonthSuffix = false): number | undefined {
  const text = normalizedCellText(value);
  if (!text) return undefined;
  const pattern = allowMonthSuffix ? /^(\d+)(?:个?月)?$/u : /^\d+$/u;
  if (!pattern.test(text)) return undefined;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) return undefined;
  return parsed;
}

function parsePositiveQuantity(value: unknown): number | undefined {
  const text = normalizedCellText(value)?.replace(/，/gu, ",");
  if (!text) return undefined;
  if (text.includes(",") && !/^\d{1,3}(?:,\d{3})+$/u.test(text)) return undefined;
  const digits = text.replace(/,/gu, "");
  if (!/^\d+$/u.test(digits)) return undefined;
  const parsed = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_QUANTITY) return undefined;
  return parsed;
}

type MoneyParseResult =
  | { cents: number }
  | { error: "INVALID_AMOUNT" | "AMOUNT_PRECISION" | "AMOUNT_TOO_LARGE" };

function parseMoneyToCents(value: unknown): MoneyParseResult {
  let text = normalizedCellText(value);
  if (!text) return { error: "INVALID_AMOUNT" };
  text = text.replace(/\s+/gu, "").replace(/，/gu, ",");
  const currencyToken = "(?:人民币|RMB|CNY|USD|AED|SAR|EUR|GBP|JPY|¥|￥|\\$|€|£)";
  text = text
    .replace(new RegExp(`^${currencyToken}`, "iu"), "")
    .replace(new RegExp(`${currencyToken}$`, "iu"), "");
  if (text.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(text)) {
    return { error: "INVALID_AMOUNT" };
  }
  text = text.replace(/,/gu, "");
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!match) return { error: "INVALID_AMOUNT" };
  const fraction = match[2] ?? "";
  if (fraction.length > 2) return { error: "AMOUNT_PRECISION" };
  try {
    const cents = BigInt(match[1] ?? "0") * 100n + BigInt(fraction.padEnd(2, "0") || "0");
    if (cents > BigInt(MAX_UNIT_PRICE_CENTS)) return { error: "AMOUNT_TOO_LARGE" };
    return { cents: Number(cents) };
  } catch {
    return { error: "INVALID_AMOUNT" };
  }
}

function normalizeCurrency(value: unknown): string | undefined {
  const text = normalizedCellText(value);
  if (!text) return undefined;
  const alias = CURRENCY_ALIASES[text.toLocaleLowerCase("en-US")] ?? CURRENCY_ALIASES[text];
  if (alias) return alias;
  const upper = text.toLocaleUpperCase("en-US");
  return /^[A-Z]{3}$/u.test(upper) ? upper : undefined;
}

function normalizeRow(
  rawRow: readonly unknown[],
  rowNumber: number,
  headers: readonly string[],
  mapping: OrderImportMapping,
  limits: OrderImportLimits,
): OrderImportRow {
  const errors: OrderImportRowError[] = [];
  const blockedColumns = new Set<number>();
  const fieldByColumn = new Map<number, OrderImportField>();
  for (const field of ORDER_IMPORT_FIELDS) {
    const columnNumber = mapping[field];
    if (columnNumber !== undefined) fieldByColumn.set(columnNumber, field);
  }
  const addError = (
    code: string,
    message: string,
    field?: OrderImportField,
    columnNumber = field ? mapping[field] : undefined,
  ) => errors.push({ code, message, field, columnNumber });

  rawRow.forEach((cell, index) => {
    if (typeof cell !== "string") return;
    const columnNumber = index + 1;
    const field = fieldByColumn.get(columnNumber);
    if (cell.length > limits.maxCellCharacters) {
      blockedColumns.add(columnNumber);
      addError("VALUE_TOO_LONG", `单元格不能超过 ${limits.maxCellCharacters} 个字符`, field, columnNumber);
    } else if (isFormulaLike(cell)) {
      blockedColumns.add(columnNumber);
      addError("FORMULA_NOT_ALLOWED", "不允许以 =、+、- 或 @ 开头的公式型内容", field, columnNumber);
    }
  });

  const getCell = (field: OrderImportField): unknown => {
    const columnNumber = mapping[field];
    if (columnNumber === undefined || blockedColumns.has(columnNumber)) return null;
    return rawRow[columnNumber - 1] ?? null;
  };
  const isBlocked = (field: OrderImportField): boolean => blockedColumns.has(mapping[field] ?? -1);
  const requiredText = (field: OrderImportField, label: string, maximum: number): string | null => {
    const raw = getCell(field);
    if (isEmptyCell(raw)) {
      if (!blockedColumns.has(mapping[field] ?? -1)) addError("REQUIRED", `${label}不能为空`, field);
      return null;
    }
    const value = normalizedCellText(raw);
    if (!value) {
      addError("INVALID_TEXT", `${label}必须是文本或数字`, field);
      return null;
    }
    if (value.length > maximum) {
      addError("VALUE_TOO_LONG", `${label}不能超过 ${maximum} 个字符`, field);
      return null;
    }
    return value;
  };

  const partnerName = requiredText("partnerName", "客户/供应商名称", MAX_PARTNER_NAME);
  const orderNo = requiredText("orderNo", "订单号", MAX_ORDER_NO);
  const itemDescription = requiredText("itemDescription", "商品名称", MAX_ITEM_DESCRIPTION);

  const partnerColumn = mapping.partnerName;
  const directionHint = directionHintFromPartnerHeader(partnerColumn ? headers[partnerColumn - 1] : undefined);
  const directionRaw = getCell("direction");
  let direction: OrderImportDirection | null = null;
  if (isBlocked("direction")) {
    direction = null;
  } else if (isEmptyCell(directionRaw)) {
    direction = directionHint ?? null;
    if (!direction) addError("REQUIRED", "方向不能为空，且往来单位表头无法推断方向", "direction");
  } else {
    const directionText = normalizedCellText(directionRaw);
    direction = directionText ? directionFromValue(directionText) ?? null : null;
    if (!direction) addError("INVALID_DIRECTION", "方向必须是应收或应付", "direction");
    if (direction && directionHint && direction !== directionHint) {
      addError("DIRECTION_HEADER_CONFLICT", "方向与客户/供应商表头不一致", "direction");
    }
  }

  const orderDateRaw = getCell("orderDate");
  const orderDate = parseCalendarDate(orderDateRaw) ?? null;
  if (!orderDate && !isBlocked("orderDate")) {
    addError(isEmptyCell(orderDateRaw) ? "REQUIRED" : "INVALID_DATE", "订货日期必须是有效的年月日", "orderDate");
  }

  const deliveryRaw = getCell("plannedDeliveryDate");
  const plannedDeliveryDate = isEmptyCell(deliveryRaw) ? null : parseCalendarDate(deliveryRaw) ?? null;
  if (!isEmptyCell(deliveryRaw) && !plannedDeliveryDate) {
    addError("INVALID_DATE", "计划交货日期必须是有效的年月日", "plannedDeliveryDate");
  } else if (orderDate && plannedDeliveryDate && plannedDeliveryDate < orderDate) {
    addError("DELIVERY_BEFORE_ORDER", "计划交货日期不能早于订货日期", "plannedDeliveryDate");
  }

  const settlementRaw = getCell("settlementMonths");
  let settlementMonths = 0;
  if (!isEmptyCell(settlementRaw)) {
    const parsed = parseNonNegativeInteger(settlementRaw, MAX_SETTLEMENT_MONTHS, true);
    if (parsed === undefined) {
      addError("INVALID_INTEGER", `账期月数必须是 0 到 ${MAX_SETTLEMENT_MONTHS} 的整数`, "settlementMonths");
    } else {
      settlementMonths = parsed;
    }
  }

  const currencyRaw = getCell("currency");
  let currency = "CNY";
  if (!isEmptyCell(currencyRaw)) {
    const parsed = normalizeCurrency(currencyRaw);
    if (!parsed) addError("INVALID_CURRENCY", "币种必须是三位字母代码", "currency");
    else currency = parsed;
  }

  const quantityRaw = getCell("quantity");
  const quantity = parsePositiveQuantity(quantityRaw) ?? null;
  if (quantity === null && !isBlocked("quantity")) {
    addError(isEmptyCell(quantityRaw) ? "REQUIRED" : "INVALID_INTEGER", `数量必须是 1 到 ${MAX_QUANTITY} 的整数`, "quantity");
  }

  const unitPriceRaw = getCell("unitPrice");
  const money = parseMoneyToCents(unitPriceRaw);
  let unitPriceCents: number | null = null;
  if ("error" in money) {
    const messages = {
      INVALID_AMOUNT: "单价必须是有效的非负金额",
      AMOUNT_PRECISION: "单价最多保留两位小数",
      AMOUNT_TOO_LARGE: `单价不能超过 ${MAX_UNIT_PRICE_CENTS} 分`,
    } as const;
    if (!isBlocked("unitPrice")) {
      addError(isEmptyCell(unitPriceRaw) ? "REQUIRED" : money.error, messages[money.error], "unitPrice");
    }
  } else {
    unitPriceCents = money.cents;
  }

  let lineTotalCents: number | null = null;
  if (quantity !== null && unitPriceCents !== null) {
    const total = quantity * unitPriceCents;
    if (!Number.isSafeInteger(total) || total <= 0) {
      addError("INVALID_LINE_TOTAL", "数量乘以单价后的订单金额必须大于 0 且不能超出安全范围", "unitPrice");
    } else {
      lineTotalCents = total;
    }
  }

  const values: NormalizedOrderImportValues = {
    partnerName,
    orderNo,
    direction,
    orderDate,
    plannedDeliveryDate,
    settlementMonths,
    currency,
    itemDescription,
    quantity,
    unitPriceCents,
    lineTotalCents,
  };
  return { rowNumber, values, errors, valid: errors.length === 0 };
}

function normalizeExistingOrderNumber(value: string): string {
  return normalizeBusinessText(value);
}

export async function parseOrderImport(
  buffer: Buffer,
  options: ParseOrderImportOptions = {},
): Promise<OrderImportResult> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) fileError("EMPTY_FILE", "导入文件不能为空");
  const limits = resolveLimits(options.limits);
  if (buffer.length > limits.maxFileBytes) {
    fileError("FILE_TOO_LARGE", `导入文件不能超过 ${limits.maxFileBytes} 字节`);
  }
  const format = inferFormat(buffer, options);
  const table = await readImportTable(buffer, format, limits);
  const headerRow = table.rows[0];
  if (!headerRow || isEmptyRow(headerRow)) fileError("HEADER_REQUIRED", "第一行必须是表头");
  if (headerRow.length > limits.maxColumns) {
    fileError("TOO_MANY_COLUMNS", `导入文件不能超过 ${limits.maxColumns} 列`);
  }

  const headers = headerRow.map((cell, index) => {
    if (typeof cell === "string" && isFormulaLike(cell)) {
      fileError("FORMULA_NOT_ALLOWED", "表头不能包含公式型内容", { columnNumber: index + 1 });
    }
    const text = cell instanceof Date ? undefined : normalizedCellText(cell);
    if (text && text.length > limits.maxCellCharacters) {
      fileError("CELL_TOO_LARGE", `表头不能超过 ${limits.maxCellCharacters} 个字符`, { columnNumber: index + 1 });
    }
    return text ?? `未命名列${index + 1}`;
  });
  const resolvedMapping = resolveMapping(
    headers,
    options.mapping,
    options.autoMapHeaders !== false,
    options.allowIncompleteMapping === true,
  );

  const dataRows = table.rows
    .slice(1)
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(({ row }) => !isEmptyRow(row));
  if (dataRows.length === 0) fileError("NO_DATA_ROWS", "导入文件没有数据行");
  if (dataRows.length > limits.maxRows) {
    fileError("TOO_MANY_ROWS", `导入数据不能超过 ${limits.maxRows} 行`);
  }

  if (resolvedMapping.missingFields.length > 0) {
    return {
      format,
      encoding: table.encoding,
      headers,
      mapping: resolvedMapping.mapping,
      suggestions: resolvedMapping.suggestions,
      missingFields: resolvedMapping.missingFields,
      rows: [],
      validRowCount: 0,
      invalidRowCount: 0,
    };
  }

  const rows = dataRows.map(({ row, rowNumber }) => {
    if (row.length > limits.maxColumns) {
      fileError("TOO_MANY_COLUMNS", `导入文件不能超过 ${limits.maxColumns} 列`, { rowNumber });
    }
    return normalizeRow(row, rowNumber, headers, resolvedMapping.mapping, limits);
  });

  const existing = new Set(
    Array.from(options.existingOrderNumbers ?? [], normalizeExistingOrderNumber),
  );
  const firstRowByOrderNumber = new Map<string, number>();
  for (const row of rows) {
    const orderNo = row.values.orderNo;
    if (!orderNo) continue;
    if (existing.has(orderNo)) {
      row.errors.push({
        code: "ORDER_NO_ALREADY_EXISTS",
        message: "订单号已存在于系统中",
        field: "orderNo",
        columnNumber: resolvedMapping.mapping.orderNo,
      });
    }
    const firstRow = firstRowByOrderNumber.get(orderNo);
    if (firstRow !== undefined) {
      row.errors.push({
        code: "DUPLICATE_ORDER_NO",
        message: `订单号与第 ${firstRow} 行重复`,
        field: "orderNo",
        columnNumber: resolvedMapping.mapping.orderNo,
      });
    } else {
      firstRowByOrderNumber.set(orderNo, row.rowNumber);
    }
    row.valid = row.errors.length === 0;
  }

  const validRowCount = rows.filter((row) => row.valid).length;
  return {
    format,
    encoding: table.encoding,
    headers,
    mapping: resolvedMapping.mapping,
    suggestions: resolvedMapping.suggestions,
    missingFields: resolvedMapping.missingFields,
    rows,
    validRowCount,
    invalidRowCount: rows.length - validRowCount,
  };
}

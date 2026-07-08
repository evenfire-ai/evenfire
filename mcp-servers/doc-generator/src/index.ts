/**
 * Doc Generator MCP Server
 *
 * Generates PDF-ready HTML documents and Excel spreadsheets via StreamableHTTP transport.
 *
 * Tools:
 *   - generate_pdf:  Markdown -> styled HTML (print-ready) + text fallback
 *   - generate_excel: Structured data -> .xlsx with styled headers and alternating rows
 *   - list_artifacts: Lists all generated files in the output directory
 *
 * Health check: GET /health on the same port.
 * MCP endpoint: POST /mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { IncomingMessage, ServerResponse, createServer } from "http";
import { randomUUID } from "crypto";
import { z } from "zod";
import fs from "fs";
import path from "path";
import MarkdownIt from "markdown-it";
import ExcelJS from "exceljs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3000", 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/output";

// Ensure output directory exists on startup
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a title to a safe filename (lowercase, alphanumeric + hyphens). */
function sanitizeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

/** Strip HTML tags from a string to produce plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Wrap HTML body content in a full, print-ready HTML document with professional
 * CSS styling (fonts, margins, headers, page-break rules).
 */
function wrapHtmlDocument(title: string, bodyHtml: string, format: "a4" | "letter"): string {
  const pageSize = format === "a4"
    ? "210mm 297mm"
    : "8.5in 11in";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    /* ---------- Base Reset ---------- */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* ---------- Page & Print ---------- */
    @page {
      size: ${pageSize};
      margin: 25mm 20mm 25mm 20mm;
    }

    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      h1, h2, h3, h4 { page-break-after: avoid; }
      table, figure, pre { page-break-inside: avoid; }
      .page-break { page-break-before: always; }
    }

    /* ---------- Typography ---------- */
    body {
      font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.7;
      color: #1a1a2e;
      background: #ffffff;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 24px;
    }

    /* ---------- Document Header ---------- */
    .doc-header {
      border-bottom: 3px solid #16213e;
      padding-bottom: 16px;
      margin-bottom: 32px;
    }

    .doc-header h1 {
      font-size: 28px;
      font-weight: 700;
      color: #16213e;
      letter-spacing: -0.5px;
    }

    .doc-header .meta {
      font-size: 12px;
      color: #6b7280;
      margin-top: 6px;
    }

    /* ---------- Headings ---------- */
    h1 { font-size: 24px; font-weight: 700; color: #16213e; margin: 32px 0 16px; }
    h2 { font-size: 20px; font-weight: 600; color: #1a1a2e; margin: 28px 0 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
    h3 { font-size: 17px; font-weight: 600; color: #374151; margin: 24px 0 10px; }
    h4 { font-size: 15px; font-weight: 600; color: #4b5563; margin: 20px 0 8px; }

    /* ---------- Paragraphs & Lists ---------- */
    p { margin: 0 0 14px; }
    ul, ol { margin: 0 0 14px; padding-left: 28px; }
    li { margin-bottom: 4px; }

    /* ---------- Code ---------- */
    code {
      font-family: "JetBrains Mono", "Fira Code", "Consolas", monospace;
      font-size: 13px;
      background: #f3f4f6;
      padding: 2px 6px;
      border-radius: 4px;
      color: #dc2626;
    }

    pre {
      background: #1e293b;
      color: #e2e8f0;
      padding: 16px 20px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 0 0 16px;
      line-height: 1.5;
    }

    pre code {
      background: none;
      color: inherit;
      padding: 0;
      border-radius: 0;
    }

    /* ---------- Tables ---------- */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0 0 16px;
      font-size: 13px;
    }

    th {
      background: #16213e;
      color: #ffffff;
      font-weight: 600;
      text-align: left;
      padding: 10px 12px;
    }

    td {
      padding: 8px 12px;
      border-bottom: 1px solid #e5e7eb;
    }

    tr:nth-child(even) td { background: #f9fafb; }
    tr:hover td { background: #eff6ff; }

    /* ---------- Blockquotes ---------- */
    blockquote {
      border-left: 4px solid #3b82f6;
      background: #eff6ff;
      padding: 12px 16px;
      margin: 0 0 16px;
      color: #1e40af;
      border-radius: 0 6px 6px 0;
    }

    /* ---------- Horizontal Rule ---------- */
    hr {
      border: none;
      border-top: 1px solid #d1d5db;
      margin: 24px 0;
    }

    /* ---------- Links ---------- */
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ---------- Images ---------- */
    img { max-width: 100%; height: auto; border-radius: 6px; margin: 8px 0; }
  </style>
</head>
<body>
  <div class="doc-header">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">Generated on ${new Date().toISOString().split("T")[0]} by Clerum Doc Generator</div>
  </div>
  <div class="doc-content">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

/** Basic HTML entity escaping. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// MCP Server Factory
// ---------------------------------------------------------------------------

function createDocGeneratorServer(): McpServer {
  const server = new McpServer({
    name: "doc-generator",
    version: "1.0.0",
  });

  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

  // ---- Tool 1: generate_pdf (HTML output) --------------------------------

  server.tool(
    "generate_pdf",
    "Converts markdown content to a professional, print-ready HTML document. Also writes a plain-text version. Returns the file path and size.",
    {
      content: z.string().describe("Markdown content to convert"),
      title: z.string().describe("Document title"),
      format: z
        .enum(["a4", "letter"])
        .default("a4")
        .describe("Page format (a4 or letter)"),
    },
    async ({ content, title, format }: { content: string; title: string; format: "a4" | "letter" }) => {
      const safeName = sanitizeFilename(title);
      const htmlPath = path.join(OUTPUT_DIR, `${safeName}.html`);
      const txtPath = path.join(OUTPUT_DIR, `${safeName}.txt`);

      // Render markdown to HTML body
      const bodyHtml = md.render(content);

      // Wrap in full styled document
      const fullHtml = wrapHtmlDocument(title, bodyHtml, format);

      // Write HTML
      fs.writeFileSync(htmlPath, fullHtml, "utf-8");

      // Write plain text version
      const plainText = `${title}\n${"=".repeat(title.length)}\n\n${stripHtml(bodyHtml)}`;
      fs.writeFileSync(txtPath, plainText, "utf-8");

      const stats = fs.statSync(htmlPath);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              filePath: htmlPath,
              textFilePath: txtPath,
              sizeBytes: stats.size,
              format: "html",
            }),
          },
        ],
      };
    }
  );

  // ---- Tool 2: generate_excel --------------------------------------------

  server.tool(
    "generate_excel",
    "Creates an Excel (.xlsx) workbook with styled sheets. Supports multiple sheets with headers and rows, bold headers, auto-width columns, and alternating row colors.",
    {
      sheets: z
        .array(
          z.object({
            name: z.string().describe("Worksheet name"),
            headers: z.array(z.string()).describe("Column headers"),
            rows: z.array(z.array(z.string())).describe("Row data (array of arrays)"),
          })
        )
        .describe("Array of sheet definitions"),
      title: z.string().describe("Workbook filename title"),
    },
    async ({
      sheets,
      title,
    }: {
      sheets: Array<{ name: string; headers: string[]; rows: string[][] }>;
      title: string;
    }) => {
      const safeName = sanitizeFilename(title);
      const xlsxPath = path.join(OUTPUT_DIR, `${safeName}.xlsx`);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Clerum Doc Generator";
      workbook.created = new Date();

      for (const sheet of sheets) {
        const ws = workbook.addWorksheet(sheet.name);

        // Set columns with headers and auto-width estimation
        ws.columns = sheet.headers.map((header) => {
          // Estimate width: max of header length and longest cell in that column
          const colIndex = sheet.headers.indexOf(header);
          const maxDataLen = sheet.rows.reduce((max, row) => {
            const cellLen = (row[colIndex] || "").length;
            return cellLen > max ? cellLen : max;
          }, 0);
          const width = Math.max(header.length, maxDataLen, 10) + 4;

          return { header, key: header, width: Math.min(width, 50) };
        });

        // Style header row: bold, white text on dark background
        const headerRow = ws.getRow(1);
        headerRow.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        headerRow.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF16213E" },
        };
        headerRow.alignment = { vertical: "middle", horizontal: "left" };
        headerRow.height = 24;

        // Add data rows
        for (let rowIdx = 0; rowIdx < sheet.rows.length; rowIdx++) {
          const dataRow = sheet.rows[rowIdx];
          const rowObj: Record<string, string> = {};
          sheet.headers.forEach((h, i) => {
            rowObj[h] = dataRow[i] || "";
          });
          const excelRow = ws.addRow(rowObj);

          // Alternating row colors
          if (rowIdx % 2 === 0) {
            excelRow.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFF9FAFB" },
            };
          }

          excelRow.alignment = { vertical: "middle" };
        }

        // Add thin borders to all cells with data
        const lastRow = ws.rowCount;
        const lastCol = sheet.headers.length;
        for (let r = 1; r <= lastRow; r++) {
          for (let c = 1; c <= lastCol; c++) {
            const cell = ws.getCell(r, c);
            cell.border = {
              top: { style: "thin", color: { argb: "FFE5E7EB" } },
              bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
              left: { style: "thin", color: { argb: "FFE5E7EB" } },
              right: { style: "thin", color: { argb: "FFE5E7EB" } },
            };
          }
        }
      }

      await workbook.xlsx.writeFile(xlsxPath);
      const stats = fs.statSync(xlsxPath);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              filePath: xlsxPath,
              sizeBytes: stats.size,
              sheets: sheets.length,
            }),
          },
        ],
      };
    }
  );

  // ---- Tool 3: list_artifacts --------------------------------------------

  server.tool(
    "list_artifacts",
    "Lists all generated files in the output directory with name, path, size, and creation date.",
    {},
    async () => {
      let entries: string[];
      try {
        entries = fs.readdirSync(OUTPUT_DIR);
      } catch {
        entries = [];
      }

      const files = entries
        .map((name) => {
          const filePath = path.join(OUTPUT_DIR, name);
          try {
            const stats = fs.statSync(filePath);
            if (!stats.isFile()) return null;
            return {
              name,
              path: filePath,
              sizeBytes: stats.size,
              createdAt: stats.birthtime.toISOString(),
            };
          } catch {
            return null;
          }
        })
        .filter((f) => f !== null);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ files }),
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// StreamableHTTP Transport (raw http, matching mock-mcp-server pattern)
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Existing session
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // New POST = new session (initialize)
  if (req.method === "POST") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    // Connect a fresh McpServer to this transport BEFORE handling the request.
    const server = createDocGeneratorServer();
    await server.connect(transport);

    // Handle the incoming initialize request.
    await transport.handleRequest(req, res);

    // Extract session ID assigned by the transport.
    const assignedSessionId = (transport as any).sessionId as string | undefined;
    if (assignedSessionId) {
      transports.set(assignedSessionId, transport);
      console.log(`[DocGenerator] New session: ${assignedSessionId}`);
    }

    transport.onclose = () => {
      if (assignedSessionId) {
        transports.delete(assignedSessionId);
        console.log(`[DocGenerator] Session closed: ${assignedSessionId}`);
      }
    };

    return;
  }

  // Non-POST without session
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Bad request - send POST to initialize" }));
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  // Health check
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        tools: ["generate_pdf", "generate_excel", "list_artifacts"],
        outputDir: OUTPUT_DIR,
      })
    );
    return;
  }

  // MCP endpoint
  if (req.url === "/mcp") {
    try {
      await handleMcp(req, res);
    } catch (e) {
      console.error("[DocGenerator] Error:", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    }
    return;
  }

  // Not found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[DocGenerator] StreamableHTTP server listening on port ${PORT}`);
  console.log(`[DocGenerator] Output directory: ${OUTPUT_DIR}`);
  console.log(`[DocGenerator] Health check: GET http://0.0.0.0:${PORT}/health`);
  console.log(`[DocGenerator] MCP endpoint:  POST http://0.0.0.0:${PORT}/mcp`);
});

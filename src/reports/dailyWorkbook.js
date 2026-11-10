"use strict";

const { strToU8, zipSync } = require("fflate");

function escapeXml(value) {
    return String(value ?? "")
        .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "")
        .replace(/[<>&'"]/g, character => ({
            "<": "&lt;",
            ">": "&gt;",
            "&": "&amp;",
            "'": "&apos;",
            "\"": "&quot;"
        })[character]);
}

function worksheetXml(rows, widths) {
    const sheetRows = rows.map((row, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const cells = row.map((value, columnIndex) => {
            const column = String.fromCharCode(65 + columnIndex);
            if (typeof value === "number" && Number.isFinite(value)) {
                return `<c r="${column}${rowNumber}" t="n"><v>${value}</v></c>`;
            }
            return `<c r="${column}${rowNumber}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        }).join("");
        return `<row r="${rowNumber}">${cells}</row>`;
    }).join("");
    const columns = widths.map((width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
    ).join("");
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        `<cols>${columns}</cols><sheetData>${sheetRows}</sheetData></worksheet>`;
}

function createDailyReportsWorkbook(reports, incidences = []) {
    const sheets = [
        {
            name: "Reportes diarios",
            widths: [14, 26, 28, 18, 38, 18, 22, 16, 20, 80],
            rows: [
                ["Fecha", "Hora de envío (UTC)", "Operador", "Llamadas realizadas", "Efectivas por zona", "No efectivas", "Solventes no cargadas", "Pagos expeditos", "Total cobranza", "Reporte / notas"],
                ...reports.map(report => {
                    const details = report.details || {};
                    const stats = details.callStats || {};
                    const zones = Array.isArray(details.effectiveByZone) ? details.effectiveByZone : [];
                    const payments = Array.isArray(details.payments) ? details.payments : [];
                    return [
                        report.date,
                        report.submittedAt,
                        report.operator,
                        stats.callsMade ?? "",
                        zones.map(zone => `${zone.zone}: ${zone.count}`).join("; "),
                        stats.callsNotEffective ?? "",
                        stats.solventesNotLoaded ?? "",
                        payments.length,
                        stats.collectionTotal ?? "",
                        report.content
                    ];
                })
            ]
        },
        {
            name: "Efectivas por zona",
            widths: [14, 28, 30, 18],
            rows: [
                ["Fecha", "Operador", "Zona", "Llamadas efectivas"],
                ...reports.flatMap(report => (report.details?.effectiveByZone || []).map(zone =>
                    [report.date, report.operator, zone.zone, zone.count]
                ))
            ]
        },
        {
            name: "Pagos expeditos",
            widths: [14, 28, 30, 24, 20],
            rows: [
                ["Fecha", "Operador", "Razón social", "CC", "Monto"],
                ...reports.flatMap(report => (report.details?.payments || []).map(payment =>
                    [report.date, report.operator, payment.razonSocial, payment.cc, payment.amount]
                ))
            ]
        },
        {
            name: "Incidencias",
            widths: [14, 26, 28, 18, 32, 18, 24, 18, 30, 24, 60],
            rows: [
                ["Fecha", "Hora de registro (UTC)", "Operador", "Tipo", "Razón social", "CC", "Municipio", "Monto", "Contacto", "Teléfono", "Motivo / observaciones"],
                ...incidences.map(incidence => [
                    incidence.date,
                    incidence.submittedAt,
                    incidence.operator,
                    incidence.type,
                    incidence.razonSocial,
                    incidence.cc,
                    incidence.municipio,
                    incidence.amount ?? "",
                    incidence.contact?.name || "",
                    incidence.contact?.phone || "",
                    incidence.description || ""
                ])
            ]
        }
    ];
    const files = {
        "[Content_Types].xml": strToU8(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            sheets.map((sheet, index) =>
                `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
            ).join("") +
            '</Types>'
        ),
        "_rels/.rels": strToU8(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            '</Relationships>'
        ),
        "xl/workbook.xml": strToU8(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            `<sheets>${sheets.map((sheet, index) =>
                `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
            ).join("")}</sheets></workbook>`
        ),
        "xl/_rels/workbook.xml.rels": strToU8(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            sheets.map((sheet, index) =>
                `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
            ).join("") +
            '</Relationships>'
        )
    };
    sheets.forEach((sheet, index) => {
        files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheetXml(sheet.rows, sheet.widths));
    });
    return Buffer.from(zipSync(files));
}

module.exports = { createDailyReportsWorkbook };

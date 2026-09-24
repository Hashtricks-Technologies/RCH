import type { QrMode } from "../types";

/**
 * The poster a QR code is printed on, placed where the customer scans it: an A5 portrait page with
 * the outlet's name, the code large in the middle, where it is placed, and how the order reaches
 * the customer. Like `lib/pdf.ts`, jsPDF - and here the `qrcode` encoder too - is imported at the
 * press, so neither is in the bundle until somebody asks for a poster.
 */

const HOSPITAL = "Royal Care Hospital";

/** The link a code encodes: the customer's ordering page for that token, on the host the admin
 *  is signed in to - so a poster for the live hospital is printed from the live domain. */
export const qrOrderUrl = (token: string): string => `${window.location.origin}/order/${token}`;

/** How each mode reads on the poster, under the code. */
const MODE_LINE: Readonly<Record<QrMode, string>> = {
  pickup: "Pick up at the counter",
  deliver: "Delivered to this spot",
};

/** `QR-Coffee-Shop-Table-4.pdf`: anything a file name should not carry becomes a dash. */
export const posterFileName = (outletName: string, label: string): string =>
  `QR-${outletName}-${label}.pdf`.replace(/[^\w.-]+/g, "-");

/** jsPDF's built-in fonts carry no rupee glyph and no curly punctuation, as in `lib/pdf.ts`. */
const pdfText = (s: string) => s.replace(/₹/g, "Rs. ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

type QrLib = typeof import("qrcode");

/** `qrcode` is CommonJS: the production chunk exports only a default, while the test mock and
 *  Vite's dev server may hand back the namespace - so take whichever carries the functions. */
async function loadQr(): Promise<QrLib> {
  const m = (await import("qrcode")) as QrLib & { default?: QrLib };
  return m.default ?? m;
}

export async function downloadQrPoster({ outletName, label, mode, url }: {
  outletName: string; label: string; mode: QrMode; url: string;
}): Promise<void> {
  const [{ jsPDF }, qr] = await Promise.all([import("jspdf"), loadQr()]);
  // Error correction M survives a scuffed or partly covered print; the margin is the quiet zone a
  // phone's camera needs around the code.
  const png = await qr.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 1024 });

  const doc = new jsPDF({ unit: "mm", format: "a5", orientation: "portrait" });
  const W = 148;
  const C = W / 2;
  doc.setProperties({ title: pdfText(`${outletName} - ${label}`) });

  doc.setFont("helvetica", "normal").setFontSize(11).text(HOSPITAL, C, 16, { align: "center" });
  doc.setFont("helvetica", "bold").setFontSize(26).text(pdfText(outletName), C, 30, { align: "center", maxWidth: W - 16 });

  const size = 96;
  doc.addImage(png, "PNG", C - size / 2, 40, size, size);

  doc.setFont("helvetica", "bold").setFontSize(18).text(pdfText(label), C, 148, { align: "center", maxWidth: W - 16 });
  doc.setFont("helvetica", "normal").setFontSize(14).text("Scan to order and pay online", C, 160, { align: "center" });
  doc.setFontSize(12).text(MODE_LINE[mode], C, 169, { align: "center" });
  doc.setFontSize(7).text(url, C, 198, { align: "center", maxWidth: W - 20 });

  doc.save(posterFileName(outletName, label));
}

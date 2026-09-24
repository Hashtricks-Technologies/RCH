import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadQrPoster, posterFileName, posterOriginWarning, qrOrderUrl } from "../lib/qrPoster";
import { menuPath } from "../lib/orderPath";

/** What the poster was asked to draw, encode and save - neither jsPDF nor the encoder runs here. */
const pdf = vi.hoisted(() => ({
  texts: [] as string[], images: [] as unknown[][], saved: [] as string[], opts: [] as unknown[], encoded: [] as unknown[][],
}));

vi.mock("jspdf", () => {
  class jsPDF {
    constructor(o: unknown) { pdf.opts.push(o); }
    setFont() { return this; }
    setFontSize() { return this; }
    setProperties() { return this; }
    text(s: string) { pdf.texts.push(s); return this; }
    addImage(...a: unknown[]) { pdf.images.push(a); return this; }
    save(name: string) { pdf.saved.push(name); }
  }
  return { jsPDF };
});
vi.mock("qrcode", () => {
  const toDataURL = (...a: unknown[]) => { pdf.encoded.push(a); return Promise.resolve("data:image/png;base64,QR"); };
  return { default: { toDataURL }, toDataURL };
});

beforeEach(() => {
  pdf.texts.length = 0; pdf.images.length = 0; pdf.saved.length = 0; pdf.opts.length = 0; pdf.encoded.length = 0;
});

describe("the QR poster", () => {
  it("links a token to the ordering page on this host", () => {
    expect(qrOrderUrl("tok_AAAA")).toBe(`${window.location.origin}/order/tok_AAAA`);
    // Encoded exactly as the ordering page's own address.
    expect(qrOrderUrl("a b/c?")).toBe(`${window.location.origin}/order/a%20b%2Fc%3F`);
    expect(qrOrderUrl("a b/c?")).toBe(`${window.location.origin}${menuPath("a b/c?")}`);
  });

  it("warns about an address a customer's phone cannot use, and is quiet on the live site", () => {
    const warn = (o: string) => `Posters printed from this address will point to ${o} - print them from the live site.`;
    expect(posterOriginWarning("https://rch.hashtrickstechnologies.com")).toBeNull();
    expect(posterOriginWarning("http://rch.hashtrickstechnologies.com")).toBe(warn("http://rch.hashtrickstechnologies.com"));
    expect(posterOriginWarning("https://localhost:5173")).toBe(warn("https://localhost:5173"));
    expect(posterOriginWarning("https://app.localhost")).toBe(warn("https://app.localhost"));
    expect(posterOriginWarning("https://192.168.1.20")).toBe(warn("https://192.168.1.20"));
    expect(posterOriginWarning("https://[::1]:8443")).toBe(warn("https://[::1]:8443"));
    expect(posterOriginWarning("null")).toBe(warn("null"));
    expect(posterOriginWarning()).toBe(warn(window.location.origin));
  });

  it("names the file after the outlet and the label, safe for any disk", () => {
    expect(posterFileName("Coffee Shop", "Ward 3B / bay 2")).toBe("QR-Coffee-Shop-Ward-3B-bay-2.pdf");
  });

  it("draws an A5 page: the hospital, the outlet, the code large, the label, the call to scan, the mode and the link", async () => {
    const url = "https://rch.example/order/tok_AAAA";
    await downloadQrPoster({ outletName: "Coffee Shop", label: "Table 4", mode: "pickup", url });
    expect(pdf.opts).toEqual([{ unit: "mm", format: "a5", orientation: "portrait" }]);
    expect(pdf.encoded).toEqual([[url, { errorCorrectionLevel: "M", margin: 2, width: 1024 }]]);
    expect(pdf.images).toHaveLength(1);
    expect(pdf.images[0].slice(0, 2)).toEqual(["data:image/png;base64,QR", "PNG"]);
    expect(pdf.images[0][4]).toBeGreaterThanOrEqual(90);        // large: most of the page's width
    expect(pdf.texts).toEqual([
      "Royal Care Hospital", "Coffee Shop", "Table 4", "Scan to order and pay online", "Pick up at the counter", url,
    ]);
    expect(pdf.saved).toEqual(["QR-Coffee-Shop-Table-4.pdf"]);
  });

  it("says a deliver code's order comes to the spot, and spells the rupee jsPDF cannot draw", async () => {
    await downloadQrPoster({ outletName: "Café ₹ corner", label: "Ward 3B", mode: "deliver", url: "u" });
    expect(pdf.texts).toContain("Delivered to this spot");
    expect(pdf.texts).toContain("Café Rs.  corner");
  });
});

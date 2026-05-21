import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ARVIL — Log Qualification for TheRock CI",
  description:
    "Analyze ROCm/TheRock GitHub Actions logs with RAG-powered triage",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "NEXA AI — Production Telegram AI Assistant",
  description:
    "NEXA AI is an intelligent Telegram assistant powered by Google Gemini, with persistent PostgreSQL conversation memory.",
  icons: {
    icon: "/assets/nexa-ai-mark.png",
    shortcut: "/assets/nexa-ai-mark.png",
    apple: "/assets/nexa-ai-mark.png",
  },
  openGraph: {
    title: "NEXA AI — Intelligent Telegram Assistant",
    description: "Ask questions, explore ideas and get intelligent assistance with NEXA AI.",
    images: ["/assets/nexa-ai-avatar.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#050914] text-slate-100 antialiased selection:bg-cyan-500/30 selection:text-cyan-100">
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import { PolarisProvider } from "@/components/PolarisProvider";

export const metadata: Metadata = {
  title: "wa-hub Dashboard",
  description: "Manage WhatsApp instances, messages, and webhooks",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <PolarisProvider>{children}</PolarisProvider>
      </body>
    </html>
  );
}

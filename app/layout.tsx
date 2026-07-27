import type { Metadata } from "next";
import { Geist, Patrick_Hand } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const patrickHand = Patrick_Hand({
  variable: "--font-sketch",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "squig — wireframes that know they're wireframes",
  description:
    "An infinite canvas of real UI components that all render like you sketched them on a napkin. Argue about structure, not corner radius.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${patrickHand.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}

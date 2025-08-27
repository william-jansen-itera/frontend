"use client";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { useAuth } from "./useAuth";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});


export default function RootLayout({ children }) {
  const { user, signIn, signOut } = useAuth();
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <nav style={{ marginBottom: "2rem", display: "flex", alignItems: "center", gap: "1rem" }}>
          <Link href="/" style={{ marginRight: "1rem" }}>Home</Link>
          <Link href="/about">About</Link>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "1rem" }}>
            {!user ? (
              <button onClick={signIn} style={{ padding: "0.5rem 1rem", borderRadius: "4px", background: "#2563eb", color: "white", border: "none" }}>Sign In</button>
            ) : (
              <>
                <span>Welcome, {user.userDetails}!</span>
                <button onClick={signOut} style={{ padding: "0.5rem 1rem", borderRadius: "4px", background: "#374151", color: "white", border: "none" }}>Sign Out</button>
              </>
            )}
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}

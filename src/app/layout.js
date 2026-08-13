"use client";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "./useAuth";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const navLinks = [
  { href: "/about", label: "About" },
  { href: "/notes", label: "Notes" },
  { href: "/chat", label: "Ask" },
  { href: "/search", label: "Search" },
];

function getPageSurfaceClassName(pathname) {
  if (pathname === "/notes") {
    return "appPageSurface appPageSurfaceNotes";
  }

  if (pathname === "/chat") {
    return "appPageSurface appPageSurfaceChat";
  }

  if (pathname === "/search") {
    return "appPageSurface appPageSurfaceSearch";
  }

  if (pathname === "/about") {
    return "appPageSurface appPageSurfaceAbout";
  }

  return "appPageSurface appPageSurfaceHome";
}

export default function RootLayout({ children }) {
  const { user, signIn, signOut } = useAuth();
  const pathname = usePathname();

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <div className={getPageSurfaceClassName(pathname)}>
          <header className="appChrome">
            <nav className="appNav">
              <div className="appNavBrandGroup">
                <Link href="/" className="appBrandLink">Knowledge App</Link>
                <div className="appNavLinks">
                  {navLinks.map((link) => {
                    const isActive = pathname === link.href;

                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        className={`appNavLink ${isActive ? "appNavLinkActive" : ""}`.trim()}
                      >
                        {link.label}
                      </Link>
                    );
                  })}
                </div>
              </div>

              <div className="appAuthGroup">
              {!user ? (
                  <button onClick={signIn} className="appAuthButton appAuthButtonPrimary">Sign In</button>
              ) : (
                <>
                    <span className="appAuthText">Welcome, {user.userDetails}!</span>
                    <button onClick={signOut} className="appAuthButton appAuthButtonSecondary">Sign Out</button>
                </>
              )}
              </div>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}

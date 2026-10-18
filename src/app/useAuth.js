"use client";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  createLocalDevelopmentPrincipal,
  isLocalDevelopmentHost,
  normalizeClientPrincipal,
} from "@/shared/clientPrincipal";

const AuthContext = createContext(null);

function useResolvedAuthState() {
  const [user, setUser] = useState(null);
  const [isAuthResolved, setIsAuthResolved] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    async function getUser() {
      const isLocal = typeof window !== 'undefined' && isLocalDevelopmentHost(window.location.hostname);

      if (isLocal) {
        if (!isCancelled) {
          setUser(normalizeClientPrincipal(createLocalDevelopmentPrincipal()));
          setIsAuthResolved(true);
        }
        return;
      }

      try {
        const res = await fetch("/.auth/me", { cache: "no-store" });
        const data = await res.json();

        if (!isCancelled) {
          setUser(normalizeClientPrincipal(data.clientPrincipal));
        }
      } catch {
        if (!isCancelled) {
          setUser(null);
        }
      } finally {
        if (!isCancelled) {
          setIsAuthResolved(true);
        }
      }
    }

    getUser();

    return () => {
      isCancelled = true;
    };
  }, []);

  function signIn() {
    window.location.href = "/.auth/login/aad";
  }

  function signOut() {
    window.location.href = "/.auth/logout";
  }

  return useMemo(() => ({
    user,
    signIn,
    signOut,
    isAuthResolved,
  }), [user, isAuthResolved]);
}

export function AuthProvider({ children }) {
  const auth = useResolvedAuthState();

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const auth = useContext(AuthContext);

  if (!auth) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return auth;
}

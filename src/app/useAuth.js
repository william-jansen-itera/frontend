"use client";
import { useEffect, useState } from "react";
import { normalizeClientPrincipal } from "@/shared/clientPrincipal";

export function useAuth() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    if (isLocal) {
      return;
    }
    async function getUser() {
      const res = await fetch("/.auth/me");
      const data = await res.json();
      setUser(normalizeClientPrincipal(data.clientPrincipal));
    }
    getUser();
  }, []);

  function signIn() {
    window.location.href = "/.auth/login/aad";
  }

  function signOut() {
    window.location.href = "/.auth/logout";
  }

  return { user, signIn, signOut };
}

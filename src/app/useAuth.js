"use client";
import { useEffect, useState } from "react";

export function useAuth() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    async function getUser() {
      const res = await fetch("/.auth/me");
      const data = await res.json();
      setUser(data.clientPrincipal || null);
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

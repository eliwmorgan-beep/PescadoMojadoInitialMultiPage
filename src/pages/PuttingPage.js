import React, { useEffect, useMemo, useState } from "react";
import Header from "../components/Header";
import { db, ensureAnonAuth } from "../firebase";
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";

const LEAGUE_ID = "default-league";
const ADMIN_PASSWORD = "Pescado!";

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

function pointsForMade(made) {
  const m = Number(made);
  if (m >= 4) return 5;
  if (m === 3) return 3;
  if (m === 2) return 2;
  if (m === 1) return 1;
  return 0;
}

function clampMade(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(4, n));
}

/**
 * Build "best" card group sizes:
 * - Prefer 4s
 * - Allow some 3s
 * - Avoid 2s whenever possible
 */
function computeCardSizes(n) {
  if (n <= 0) return [];
  if (n <= 4) return [n]; // safe fallback

  const rem = n % 4;

  if (rem === 0) return Array.from({ length: n / 4 }, () => 4);

  // rem 1 => convert one 4+1 into 3+3 (uses 6)
  if (rem === 1) {
    if (n === 5) return [3, 2]; // unavoidable edge case
    const fours = (n - 6) / 4;
    return [...Array.from({ length: fours }, () => 4), 3, 3];
  }

  // rem 2 => convert one 4+2 into 3+3 (uses 6)
  if (rem === 2) {
    if (n === 6) return [3, 3];
    const fours = (n - 6) / 4;
    return [...Array.from({ length: fours }, () => 4), 3, 3];
  }

  // rem 3 => one 3 + rest 4
  const fours = (n - 3) / 4;
  return [...Array.from({ length: fours }, () => 4), 3];
}

export default function PuttingPage() {
  // --- Palette / look (match Tags theme) ---
  const COLORS = {
    navy: "#1b1f5a",
    blueLight: "#e6f3ff",
    orange: "#f4a83a",
    green: "#15803d",
    red: "#cc0000",
    text: "#0b1220",
    border: "#dbe9ff",
    panel: "#ffffff",
    soft: "#f6fbff",
  };

  const inputStyle = {
    padding: "10px 12px",
    borderRadius: 12,
    border: `1px solid ${COLORS.border}`,
    outline: "none",
    fontSize: 14,
  };

  const buttonStyle = {
    padding: "10px 14px",
    borderRadius: 12,
    border: `1px solid ${COLORS.border}`,
    background: COLORS.orange,
    color: "#1a1a1a",
    fontWeight: 800,
    cursor: "pointer",
  };

  const smallButtonStyle = {
    ...buttonStyle,
    padding: "8px 12px",
  };

  // Firestore ref
  const leagueRef = useMemo(() => doc(db, "leagues", LEAGUE_ID), []);

  // Putting league stored data
  const [putting, setPutting] = useState({
    settings: {
      stations: 9,
      rounds: 1,
      locked: false,
      currentRound: 0, // 0 = not started, else 1..rounds
      finalized: false,
      cardMode: "", // "" | "manual" | "random"
    },
    players: [], // {id, name, pool: "A"|"B"|"C"}
    cardsByRound: {}, // { "1":[{id,name,playerIds}], "2":[...] }
    scores: {}, // scores[round][station][playerId] = made(0..4)
    submitted: {}, // submitted[round][cardId] = true
  });

  // UI state
  const [setupOpen, setSetupOpen] = useState(true);
  const [checkinOpen, setCheckinOpen] = useState(true);
  const [cardsOpen, setCardsOpen] = useState(true);
  const [leaderboardsOpen, setLeaderboardsOpen] = useState(false);

  // Add player UI
  const [name, setName] = useState("");
  const [pool, setPool] = useState("A");

  // Manual card creation UI (Round 1)
  const [selectedForCard, setSelectedForCard] = useState([]); // playerIds
  const [cardName, setCardName] = useState("");

  // Scorekeeper selection UI
  const [activeCardId, setActiveCardId] = useState("");
  const [openStations, setOpenStations] = useState({}); // {stationNum: bool}

  // -------- Helpers (computed) --------
  const settings = putting.settings || {};
  const stations = Math.max(1, Math.min(10, Number(settings.stations || 9))); // 1–10
  const totalRounds = Math.max(1, Math.min(5, Number(settings.rounds || 1))); // 1–5
  const currentRound = Number(settings.currentRound || 0);
  const finalized = !!settings.finalized;
  const cardMode = String(settings.cardMode || "");

  const players = Array.isArray(putting.players) ? putting.players : [];
  const cardsByRound =
    putting.cardsByRound && typeof putting.cardsByRound === "object"
      ? putting.cardsByRound
      : {};
  const scores =
    putting.scores && typeof putting.scores === "object" ? putting.scores : {};
  const submitted =
    putting.submitted && typeof putting.submitted === "object"
      ? putting.submitted
      : {};

  const roundStarted = settings.locked && currentRound >= 1;

  const r1Cards = Array.isArray(cardsByRound["1"]) ? cardsByRound["1"] : [];
  const currentCards = Array.isArray(cardsByRound[String(currentRound)])
    ? cardsByRound[String(currentRound)]
    : [];

  const playerById = useMemo(() => {
    const map = {};
    players.forEach((p) => (map[p.id] = p));
    return map;
  }, [players]);

  // After league starts, collapse check-in and admin tools by default
  useEffect(() => {
    if (roundStarted) {
      setCheckinOpen(false);
      setSetupOpen(false);
    }
  }, [roundStarted]);

  function madeFor(roundNum, stationNum, playerId) {
    const r = scores?.[String(roundNum)] || {};
    const st = r?.[String(stationNum)] || {};
    const val = st?.[playerId];
    // IMPORTANT: allow 0 and treat it as a valid recorded score
    if (val === 0) return 0;
    if (val === "0") return 0;
    return typeof val === "number" ? val : Number(val ?? 0);
  }

  function rawMadeExists(roundNum, stationNum, playerId) {
    const r = scores?.[String(roundNum)] || {};
    const st = r?.[String(stationNum)] || {};
    const raw = st?.[playerId];
    // IMPORTANT: 0 is a valid score and must count as "exists"
    return raw !== undefined && raw !== null;
  }

  function roundTotalForPlayer(roundNum, playerId) {
    let total = 0;
    for (let s = 1; s <= stations; s++) {
      total += pointsForMade(madeFor(roundNum, s, playerId));
    }
    return total;
  }

  function cumulativeTotalForPlayer(playerId) {
    let total = 0;
    for (let r = 1; r <= totalRounds; r++) {
      total += roundTotalForPlayer(r, playerId);
    }
    return total;
  }

  function submittedCountForRound(roundNum) {
    const cards = Array.isArray(cardsByRound[String(roundNum)])
      ? cardsByRound[String(roundNum)]
      : [];
    const sub = submitted?.[String(roundNum)] || {};
    const count = cards.filter((c) => !!sub?.[c.id]).length;
    return { submitted: count, total: cards.length };
  }

  function allCardsSubmittedForRound(roundNum) {
    const { submitted: s, total: t } = submittedCountForRound(roundNum);
    return t > 0 && s === t;
  }

  function missingCardsForRound(roundNum) {
    const cards = Array.isArray(cardsByRound[String(roundNum)])
      ? cardsByRound[String(roundNum)]
      : [];
    const sub = submitted?.[String(roundNum)] || {};
    return cards.filter((c) => !sub?.[c.id]);
  }

  // Password ONLY for: begin round 1 and begin next round
  function requireAdminForRoundStart(fn) {
    const pw = window.prompt("Admin password:");
    if (pw !== ADMIN_PASSWORD) {
      alert("Wrong password.");
      return;
    }
    return fn();
  }

  // -------- Firestore subscribe + bootstrap --------
  useEffect(() => {
    let unsub = () => {};

    (async () => {
      await ensureAnonAuth();

      const snap = await getDoc(leagueRef);
      if (!snap.exists()) {
        await setDoc(leagueRef, {
          players: [],
          rounds: [],
          roundHistory: [],
          defendMode: {
            enabled: false,
            scope: "podium",
            durationType: "weeks",
            weeks: 2,
            tagExpiresAt: {},
          },
          puttingLeague: {
            settings: {
              stations: 9,
              rounds: 1,
              locked: false,
              currentRound: 0,
              finalized: false,
              cardMode: "",
            },
            players: [],
            cardsByRound: {},
            scores: {},
            submitted: {},
          },
        });
      }

      unsub = onSnapshot(leagueRef, (s) => {
        const data = s.data() || {};
        const pl = data.puttingLeague || {
          settings: {
            stations: 9,
            rounds: 1,
            locked: false,
            currentRound: 0,
            finalized: false,
            cardMode: "",
          },
          players: [],
          cardsByRound: {},
          scores: {},
          submitted: {},
        };

        const safe = {
          ...pl,
          settings: {
            stations: 9,
            rounds: 1,
            locked: false,
            currentRound: 0,
            finalized: false,
            cardMode: "",
            ...(pl.settings || {}),
          },
        };

        setPutting(safe);
      });
    })().catch(console.error);

    return () => unsub();
  }, [leagueRef]);

  // --------- Firestore update helpers ---------
  async function updatePutting(patch) {
    await updateDoc(leagueRef, {
      puttingLeague: {
        ...putting,
        ...patch,
      },
    });
  }

  async function updatePuttingDot(dotPath, value) {
    await updateDoc(leagueRef, {
      [`puttingLeague.${dotPath}`]: value,
    });
  }

  // --------- Cards: generation/validation helpers ---------
  function validateRound1Cards(cards) {
    if (!Array.isArray(cards) || cards.length === 0) {
      return { ok: false, reason: "No cards created yet." };
    }

    const allIds = new Set(players.map((p) => p.id));
    const seen = new Set();

    // size rule: prefer 3-4; allow 2 only if total players === 2
    const allowTwo = players.length === 2;

    for (const c of cards) {
      const ids = Array.isArray(c.playerIds) ? c.playerIds : [];
      if (ids.length > 4)
        return { ok: false, reason: "A card has more than 4 players." };
      if (ids.length < 3 && !(allowTwo && ids.length === 2)) {
        return {
          ok: false,
          reason:
            "A card has fewer than 3 players (2 only allowed if there are exactly 2 total players).",
        };
      }

      for (const pid of ids) {
        if (!allIds.has(pid))
          return { ok: false, reason: "A card contains an unknown player." };
        if (seen.has(pid))
          return {
            ok: false,
            reason: "A player appears on more than one card.",
          };
        seen.add(pid);
      }
    }

    // everyone assigned?
    if (seen.size !== allIds.size) {
      return {
        ok: false,
        reason: "Not all checked-in players are assigned to a card yet.",
      };
    }

    return { ok: true, reason: "" };
  }

  function buildRandomCardsRound1() {
    const arr = [...players];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    const sizes = computeCardSizes(arr.length);
    const cards = [];
    let idx = 0;

    sizes.forEach((sz) => {
      const chunk = arr.slice(idx, idx + sz);
      idx += sz;
      cards.push({
        id: uid(),
        name: `Card ${cards.length + 1}`,
        playerIds: chunk.map((p) => p.id),
      });
    });

    return cards;
  }

  function buildAutoCardsFromRound(roundNum) {
    // Sort by prior round total desc, then chunk by best sizes
    const ranked = [...players]
      .map((p) => ({
        id: p.id,
        total: roundTotalForPlayer(roundNum, p.id),
      }))
      .sort((a, b) => b.total - a.total);

    const sizes = computeCardSizes(ranked.length);
    const cards = [];
    let idx = 0;

    sizes.forEach((sz) => {
      const chunk = ranked.slice(idx, idx + sz);
      idx += sz;
      cards.push({
        id: uid(),
        name: `Card ${cards.length + 1}`,
        playerIds: chunk.map((x) => x.id),
      });
    });

    return cards;
  }

  // --------- Admin actions: check-in / cards / rounds ---------
  async function addPlayer() {
    if (finalized) {
      alert("Scores are finalized. Reset to start a new league.");
      return;
    }
    if (roundStarted) return;

    const n = (name || "").trim();
    if (!n) return;

    const exists = players.some(
      (p) => (p.name || "").trim().toLowerCase() === n.toLowerCase()
    );
    if (exists) {
      alert("That name is already checked in.");
      return;
    }

    const newPlayer = { id: uid(), name: n, pool: pool || "A" };
    await updatePutting({ players: [...players, newPlayer] });

    setName("");
    setPool("A");
  }

  function toggleSelectForCard(playerId) {
    setSelectedForCard((prev) =>
      prev.includes(playerId)
        ? prev.filter((x) => x !== playerId)
        : [...prev, playerId]
    );
  }

  async function setCardModeManual() {
    if (finalized || roundStarted) return;
    await updatePutting({
      settings: { ...settings, cardMode: "manual" },
    });
    setCardsOpen(true);
  }

  async function randomizeRound1Cards() {
    if (finalized || roundStarted) return;
    if (players.length < 2) {
      alert("Check in at least 2 players first.");
      return;
    }
    const cards = buildRandomCardsRound1();
    await updatePutting({
      settings: { ...settings, cardMode: "random" },
      cardsByRound: {
        ...(putting.cardsByRound || {}),
        "1": cards,
      },
      submitted: {
        ...(putting.submitted || {}),
        "1": {}, // clear submissions
      },
    });
    setSelectedForCard([]);
    setCardName("");
    setCardsOpen(true);
  }

  async function createCard() {
    if (finalized) return;
    if (roundStarted) {
      alert("Round has started. Round 1 cards are locked.");
      return;
    }
    if (cardMode !== "manual") {
      alert("Choose 'Manually Create Cards' first.");
      return;
    }

    const count = selectedForCard.length;

    // Prefer 3-4; allow 2 only if total players == 2
    const allowTwo = players.length === 2;
    const min = allowTwo ? 2 : 3;

    if (count < min) {
      alert(`Select at least ${min} players for a card.`);
      return;
    }
    if (count > 4) {
      alert("Max 4 players per card.");
      return;
    }

    const cards = Array.isArray(cardsByRound["1"]) ? cardsByRound["1"] : [];
    const used = new Set();
    cards.forEach((c) => (c.playerIds || []).forEach((id) => used.add(id)));

    const overlaps = selectedForCard.some((id) => used.has(id));
    if (overlaps) {
      alert("One or more selected players are already assigned to a card.");
      return;
    }

    const newCard = {
      id: uid(),
      name: (cardName || "").trim() || `Card ${cards.length + 1}`,
      playerIds: selectedForCard,
    };

    await updatePuttingDot("cardsByRound.1", [...cards, newCard]);

    setSelectedForCard([]);
    setCardName("");
  }

  async function beginRoundOne() {
    if (finalized) return;

    await requireAdminForRoundStart(async () => {
      if (players.length < 2) {
        alert("Check in at least 2 players first.");
        return;
      }

      const check = validateRound1Cards(r1Cards);
      if (!check.ok) {
        alert(
          `Round 1 can't begin yet.\n\n${check.reason}\n\nTip: Choose "Manually Create Cards" or "Randomize Cards" and make sure everyone is assigned.`
        );
        return;
      }

      await updatePutting({
        settings: {
          ...settings,
          stations,
          rounds: totalRounds,
          locked: true,
          currentRound: 1,
          finalized: false,
        },
        submitted: {
          ...(putting.submitted || {}),
          "1": putting.submitted?.["1"] || {},
        },
      });

      setSetupOpen(false);
      setCheckinOpen(false);
      setCardsOpen(true);
      window.scrollTo(0, 0);
    });
  }

  async function beginNextRound() {
    if (finalized) return;

    await requireAdminForRoundStart(async () => {
      if (!settings.locked || currentRound < 1) {
        alert("Round 1 has not begun yet.");
        return;
      }
      if (currentRound >= totalRounds) {
        alert("You are already on the final round.");
        return;
      }
      if (!allCardsSubmittedForRound(currentRound)) {
        const missing = missingCardsForRound(currentRound);
        const names = missing.map((c) => c.name).join(", ");
        alert(
          `Not all cards have submitted scores for Round ${currentRound} yet.\n\nWaiting on: ${
            names || "Unknown"
          }`
        );
        return;
      }

      const nextRound = currentRound + 1;
      const autoCards = buildAutoCardsFromRound(currentRound);

      await updatePutting({
        settings: { ...settings, currentRound: nextRound },
        cardsByRound: {
          ...(putting.cardsByRound || {}),
          [String(nextRound)]: autoCards,
        },
        submitted: {
          ...(putting.submitted || {}),
          [String(nextRound)]: {},
        },
      });

      setActiveCardId("");
      setOpenStations({});
      window.scrollTo(0, 0);
    });
  }

  async function finalizeScores() {
    if (!settings.locked || currentRound < 1) {
      alert("League hasn't started yet.");
      return;
    }
    if (currentRound !== totalRounds) {
      alert("Finalize is only available on the final round.");
      return;
    }
    if (!allCardsSubmittedForRound(currentRound)) {
      const missing = missingCardsForRound(currentRound);
      const names = missing.map((c) => c.name).join(", ");
      alert(
        `Not all cards have submitted scores for the final round yet.\n\nWaiting on: ${
          names || "Unknown"
        }`
      );
      return;
    }

    await updatePutting({
      settings: { ...settings, finalized: true },
    });

    alert("Scores finalized. Leaderboards are now locked.");
  }

  async function resetPuttingLeague() {
    const ok = window.confirm(
      "Reset PUTTING league only?\n\nThis clears putting players, cards, scores, and settings.\n(Tag rounds will NOT be affected.)"
    );
    if (!ok) return;

    await updateDoc(leagueRef, {
      puttingLeague: {
        settings: {
          stations: 9,
          rounds: 1,
          locked: false,
          currentRound: 0,
          finalized: false,
          cardMode: "",
        },
        players: [],
        cardsByRound: {},
        scores: {},
        submitted: {},
      },
    });

    setActiveCardId("");
    setOpenStations({});
    setSelectedForCard([]);
    setCardName("");
    setName("");
    setPool("A");
    setSetupOpen(true);
    setCheckinOpen(true);
    setCardsOpen(true);
    setLeaderboardsOpen(false);
  }

  // -------- Scorekeeper actions --------
  function toggleStation(stationNum) {
    setOpenStations((prev) => ({
      ...prev,
      [stationNum]: !prev[stationNum],
    }));
  }

  async function setMade(roundNum, stationNum, playerId, made) {
    if (finalized) return;

    // Prevent editing older rounds once you move forward
    if (roundNum !== currentRound) {
      alert("This round is locked because the league has moved on.");
      return;
    }

    // Prevent editing after this card submitted this round
    const card = currentCards.find((c) => (c.playerIds || []).includes(playerId));
    if (card) {
      const alreadySubmitted = !!submitted?.[String(currentRound)]?.[card.id];
      if (alreadySubmitted) return;
    }

    const val = clampMade(made);
    await updatePuttingDot(
      `scores.${String(roundNum)}.${String(stationNum)}.${playerId}`,
      val
    );
  }

  function isCardFullyFilled(roundNum, card) {
    const ids = card?.playerIds || [];
    if (!ids.length) return false;

    for (let s = 1; s <= stations; s++) {
      for (const pid of ids) {
        // IMPORTANT: 0 counts as filled; only undefined/null is missing
        if (!rawMadeExists(roundNum, s, pid)) return false;
      }
    }
    return true;
  }

  async function submitCardScores(cardId) {
    if (finalized) return;

    const card = currentCards.find((c) => c.id === cardId);
    if (!card) return;

    if (!isCardFullyFilled(currentRound, card)) {
      alert("This card is missing some scores. Fill all stations for all players.");
      return;
    }

    await updatePuttingDot(`submitted.${String(currentRound)}.${cardId}`, true);
    alert("Card submitted (locked)!");
  }

  // -------- Leaderboards (by pool, cumulative) --------
  const leaderboardByPool = useMemo(() => {
    const pools = { A: [], B: [], C: [] };

    players.forEach((p) => {
      const total = cumulativeTotalForPlayer(p.id);
      const row = { id: p.id, name: p.name, pool: p.pool, total };
      if (p.pool === "B") pools.B.push(row);
      else if (p.pool === "C") pools.C.push(row);
      else pools.A.push(row);
    });

    Object.keys(pools).forEach((k) => {
      pools[k].sort((a, b) => b.total - a.total);
    });

    return pools;
  }, [players, scores, stations, totalRounds]);

  // -------- UI gating --------
  const canBeginNextRound =
    roundStarted &&
    !finalized &&
    currentRound < totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const canFinalize =
    roundStarted &&
    !finalized &&
    currentRound === totalRounds &&
    allCardsSubmittedForRound(currentRound);

  const submitStats = roundStarted
    ? submittedCountForRound(currentRound)
    : { submitted: 0, total: 0 };

  const missingCardsThisRound = roundStarted ? missingCardsForRound(currentRound) : [];

  const showCardModeButtons = !roundStarted && !finalized && players.length >= 2;

  // -------- Render --------
  return (
    <div
      style={{
        minHeight: "100vh",
        background: `linear-gradient(180deg, ${COLORS.blueLight} 0%, #ffffff 60%)`,
        display: "flex",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 760 }}>
        <div
          style={{
            textAlign: "center",
            background: COLORS.panel,
            borderRadius: 18,
            padding: 26,
            border: `2px solid ${COLORS.navy}`,
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
          }}
        >
          <Header />

          <div
            style={{
              color: COLORS.green,
              marginTop: 14,
              marginBottom: 12,
              fontWeight: 900,
            }}
          >
            Putting League{" "}
            {roundStarted ? (
              <span style={{ color: COLORS.navy }}>
                — Round {currentRound} of {totalRounds}
              </span>
            ) : (
              <span style={{ opacity: 0.75, fontWeight: 800 }}>— Not started</span>
            )}
            {finalized ? (
              <div style={{ marginTop: 6, color: COLORS.red, fontWeight: 900 }}>
                FINALIZED (locked)
              </div>
            ) : null}
          </div>

          {/* Admin status (who hasn't submitted) */}
          {roundStarted && (
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 14 }}>
              <div>
                Admin Status: Cards submitted this round —{" "}
                <strong>
                  {submitStats.submitted} / {submitStats.total}
                </strong>
              </div>

              {missingCardsThisRound.length > 0 ? (
                <div style={{ marginTop: 6 }}>
                  Waiting on:{" "}
                  <strong style={{ color: COLORS.red }}>
                    {missingCardsThisRound.map((c) => c.name).join(", ")}
                  </strong>
                </div>
              ) : (
                <div style={{ marginTop: 6, color: COLORS.green, fontWeight: 900 }}>
                  All cards submitted ✅
                </div>
              )}
            </div>
          )}

          {/* ADMIN TOOLS */}
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: COLORS.soft,
              padding: 12,
              textAlign: "left",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setSetupOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>Admin Tools</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {setupOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {setupOpen && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: "grid", gap: 10 }}>
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 6,
                      }}
                    >
                      Stations
                    </div>
                    <select
                      value={stations}
                      disabled={settings.locked || finalized}
                      onChange={(e) =>
                        updatePutting({
                          settings: {
                            ...settings,
                            stations: Number(e.target.value),
                          },
                        })
                      }
                      style={{ ...inputStyle, width: "100%", background: "#fff" }}
                    >
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        color: COLORS.navy,
                        marginBottom: 6,
                      }}
                    >
                      Rounds
                    </div>
                    <select
                      value={totalRounds}
                      disabled={settings.locked || finalized}
                      onChange={(e) =>
                        updatePutting({
                          settings: {
                            ...settings,
                            rounds: Number(e.target.value),
                          },
                        })
                      }
                      style={{ ...inputStyle, width: "100%", background: "#fff" }}
                    >
                      {Array.from({ length: 5 }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!roundStarted ? (
                    <button
                      onClick={beginRoundOne}
                      style={{
                        ...buttonStyle,
                        width: "100%",
                        background: COLORS.green,
                        color: "white",
                        border: `1px solid ${COLORS.green}`,
                      }}
                      disabled={finalized}
                      title="Requires admin password. Locks format and begins Round 1."
                    >
                      Begin Round 1 (Lock Format)
                    </button>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.75 }}>Format locked.</div>
                  )}

                  {canBeginNextRound && (
                    <button
                      onClick={beginNextRound}
                      style={{
                        ...buttonStyle,
                        width: "100%",
                        background: COLORS.navy,
                        color: "white",
                        border: `1px solid ${COLORS.navy}`,
                      }}
                      title="Requires admin password. Only appears after every card submits."
                    >
                      Begin Next Round (Auto Cards)
                    </button>
                  )}

                  {canFinalize && (
                    <button
                      onClick={finalizeScores}
                      style={{
                        ...buttonStyle,
                        width: "100%",
                        background: COLORS.red,
                        color: "white",
                        border: `1px solid ${COLORS.red}`,
                      }}
                      title="No password required. Only available after all cards submit on final round."
                    >
                      Finalize Scores (Lock)
                    </button>
                  )}

                  <button
                    onClick={resetPuttingLeague}
                    style={{
                      ...smallButtonStyle,
                      width: "100%",
                      background: "#fff",
                      border: `1px solid ${COLORS.border}`,
                    }}
                    title="No password required."
                  >
                    Reset Putting League
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* CHECK-IN */}
          {!roundStarted && (
            <div
              style={{
                border: `1px solid ${COLORS.border}`,
                borderRadius: 14,
                background: COLORS.soft,
                padding: 12,
                textAlign: "left",
                marginBottom: 12,
              }}
            >
              <div
                onClick={() => setCheckinOpen((v) => !v)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  cursor: "pointer",
                  gap: 10,
                }}
              >
                <div style={{ fontWeight: 900, color: COLORS.navy }}>
                  Player Check-In ({players.length})
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {checkinOpen ? "Tap to collapse" : "Tap to expand"}
                </div>
              </div>

              {checkinOpen && (
                <div style={{ marginTop: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <input
                      placeholder="Player name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      style={{ ...inputStyle, width: 240 }}
                      disabled={finalized}
                    />
                    <select
                      value={pool}
                      onChange={(e) => setPool(e.target.value)}
                      style={{ ...inputStyle, width: 140, background: "#fff" }}
                      disabled={finalized}
                    >
                      <option value="A">A Pool</option>
                      <option value="B">B Pool</option>
                      <option value="C">C Pool</option>
                    </select>
                    <button
                      onClick={addPlayer}
                      style={{
                        ...smallButtonStyle,
                        background: COLORS.green,
                        color: "white",
                        border: `1px solid ${COLORS.green}`,
                      }}
                      disabled={finalized}
                    >
                      Add
                    </button>
                  </div>

                  {players.length ? (
                    <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                      {players.map((p) => (
                        <div
                          key={p.id}
                          style={{
                            padding: "10px 12px",
                            borderRadius: 12,
                            border: `1px solid ${COLORS.border}`,
                            background: "#fff",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 10,
                          }}
                        >
                          <div style={{ fontWeight: 900, color: COLORS.text }}>{p.name}</div>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 900,
                              color: COLORS.navy,
                            }}
                          >
                            {p.pool === "B" ? "B Pool" : p.pool === "C" ? "C Pool" : "A Pool"}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                      Add players as they arrive.
                    </div>
                  )}

                  {/* After check-in: choose manual vs random */}
                  {showCardModeButtons && (
                    <div
                      style={{
                        marginTop: 12,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 12,
                        background: "#fff",
                        padding: 10,
                      }}
                    >
                      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10 }}>
                        Next: Create Round 1 cards
                      </div>

                      <div style={{ display: "grid", gap: 10 }}>
                        <button
                          onClick={setCardModeManual}
                          style={{
                            ...buttonStyle,
                            width: "100%",
                            background: "#fff",
                            border: `1px solid ${COLORS.navy}`,
                            color: COLORS.navy,
                          }}
                        >
                          Manually Create Cards
                        </button>

                        <button
                          onClick={randomizeRound1Cards}
                          style={{
                            ...buttonStyle,
                            width: "100%",
                            background: COLORS.navy,
                            color: "white",
                            border: `1px solid ${COLORS.navy}`,
                          }}
                        >
                          Randomize Cards
                        </button>

                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          Cards prefer 4s and then 3s (avoids 2s whenever possible).
                        </div>

                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          Current mode:{" "}
                          <strong>
                            {cardMode === "manual"
                              ? "Manual"
                              : cardMode === "random"
                              ? "Random"
                              : "Not chosen"}
                          </strong>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* CARDS */}
          <div
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: COLORS.soft,
              padding: 12,
              textAlign: "left",
              marginBottom: 12,
            }}
          >
            <div
              onClick={() => setCardsOpen((v) => !v)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                Cards — Round {currentRound || 1}
              </div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {cardsOpen ? "Tap to collapse" : "Tap to expand"}
              </div>
            </div>

            {cardsOpen && (
              <div style={{ marginTop: 10 }}>
                {!roundStarted && cardMode === "manual" ? (
                  <>
                    <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                      Create Round 1 cards (prefer 4; allow 3). Pools can be mixed.
                    </div>

                    <div
                      style={{
                        border: `1px solid ${COLORS.border}`,
                        background: "#fff",
                        borderRadius: 12,
                        padding: 10,
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 10,
                          flexWrap: "wrap",
                          alignItems: "center",
                          marginBottom: 10,
                        }}
                      >
                        <input
                          placeholder="Card name (optional)"
                          value={cardName}
                          onChange={(e) => setCardName(e.target.value)}
                          style={{ ...inputStyle, width: 240 }}
                          disabled={finalized}
                        />
                        <button
                          onClick={createCard}
                          style={{
                            ...smallButtonStyle,
                            background: COLORS.navy,
                            color: "white",
                            border: `1px solid ${COLORS.navy}`,
                          }}
                          disabled={finalized}
                        >
                          Create Card
                        </button>

                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          Selected: <strong>{selectedForCard.length}</strong> / 4
                          <span style={{ marginLeft: 8 }}>
                            (min {players.length === 2 ? 2 : 3})
                          </span>
                        </div>
                      </div>

                      <div style={{ display: "grid", gap: 8 }}>
                        {players.map((p) => {
                          const isSelected = selectedForCard.includes(p.id);
                          const already = r1Cards.some((c) =>
                            (c.playerIds || []).includes(p.id)
                          );

                          return (
                            <label
                              key={p.id}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: 10,
                                padding: "10px 12px",
                                borderRadius: 12,
                                border: `1px solid ${COLORS.border}`,
                                background: already ? "#fafafa" : COLORS.soft,
                                opacity: already ? 0.6 : 1,
                                cursor: already ? "not-allowed" : "pointer",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  disabled={already || finalized}
                                  onChange={() => toggleSelectForCard(p.id)}
                                />
                                <div style={{ fontWeight: 900 }}>{p.name}</div>
                              </div>
                              <div style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                                {p.pool === "B"
                                  ? "B Pool"
                                  : p.pool === "C"
                                  ? "C Pool"
                                  : "A Pool"}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : roundStarted && currentRound >= 2 ? (
                  <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>
                    Cards for Round {currentRound} are auto-created based on Round{" "}
                    {currentRound - 1} totals (highest grouped together).
                  </div>
                ) : !roundStarted ? (
                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
                    Choose Manual or Random cards above. Round 1 requires all players be assigned
                    to cards before starting.
                  </div>
                ) : null}

                <div style={{ display: "grid", gap: 8 }}>
                  {(Array.isArray(cardsByRound[String(currentRound || 1)])
                    ? cardsByRound[String(currentRound || 1)]
                    : []
                  ).map((c) => (
                    <div
                      key={c.id}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 12,
                        border: `1px solid ${COLORS.border}`,
                        background: "#fff",
                      }}
                    >
                      <div style={{ fontWeight: 900, color: COLORS.navy }}>
                        {c.name}
                        {roundStarted && currentRound ? (
                          <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.75 }}>
                            {submitted?.[String(currentRound)]?.[c.id]
                              ? "✓ submitted"
                              : "not submitted"}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 14 }}>
                        {(c.playerIds || []).map((pid) => {
                          const p = playerById[pid];
                          if (!p) return null;
                          return (
                            <div
                              key={pid}
                              style={{ display: "flex", justifyContent: "space-between" }}
                            >
                              <span style={{ fontWeight: 800 }}>{p.name}</span>
                              <span style={{ fontSize: 12, fontWeight: 900, color: COLORS.navy }}>
                                {p.pool === "B"
                                  ? "B Pool"
                                  : p.pool === "C"
                                  ? "C Pool"
                                  : "A Pool"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* SCOREKEEPER */}
          {roundStarted ? (
            <div
              style={{
                border: `1px solid ${COLORS.border}`,
                borderRadius: 14,
                background: "#fff",
                padding: 12,
                textAlign: "left",
                marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 8 }}>
                Scorekeeper
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  value={activeCardId}
                  onChange={(e) => {
                    setActiveCardId(e.target.value);
                    setOpenStations({});
                  }}
                  style={{ ...inputStyle, width: 280, background: "#fff" }}
                >
                  <option value="">Select your card…</option>
                  {currentCards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>

                {activeCardId ? (
                  <button
                    onClick={() => {
                      setActiveCardId("");
                      setOpenStations({});
                    }}
                    style={{ ...smallButtonStyle, background: "#fff" }}
                  >
                    Change Card
                  </button>
                ) : null}
              </div>

              {activeCardId ? (
                (() => {
                  const card = currentCards.find((c) => c.id === activeCardId);
                  if (!card) return null;

                  const cardPlayers = (card.playerIds || [])
                    .map((pid) => playerById[pid])
                    .filter(Boolean);

                  const alreadySubmitted = !!submitted?.[String(currentRound)]?.[card.id];

                  return (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 10 }}>
                        {card.name}{" "}
                        {alreadySubmitted ? (
                          <span style={{ color: COLORS.green, marginLeft: 8 }}>(submitted)</span>
                        ) : (
                          <span style={{ opacity: 0.6, marginLeft: 8 }}>(in progress)</span>
                        )}
                      </div>

                      <div style={{ display: "grid", gap: 10 }}>
                        {Array.from({ length: stations }, (_, i) => i + 1).map((stNum) => {
                          const open = !!openStations[stNum];

                          const stationRows = cardPlayers.map((p) => {
                            const made = madeFor(currentRound, stNum, p.id);
                            return {
                              id: p.id,
                              name: p.name,
                              pool: p.pool,
                              made,
                              pts: pointsForMade(made),
                            };
                          });

                          return (
                            <div
                              key={stNum}
                              style={{
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 14,
                                background: COLORS.soft,
                                overflow: "hidden",
                              }}
                            >
                              <div
                                onClick={() => toggleStation(stNum)}
                                style={{
                                  padding: "12px 12px",
                                  cursor: "pointer",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div style={{ fontWeight: 900, color: COLORS.navy }}>
                                  Station {stNum}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.75 }}>
                                  {open ? "Tap to collapse" : "Tap to expand"}
                                </div>
                              </div>

                              {open && (
                                <div style={{ padding: 12, background: "#fff" }}>
                                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
                                    Enter <strong>made putts (0–4)</strong> for each player.
                                    (4=5pts, 3=3pts, 2=2pts, 1=1pt, 0=0)
                                  </div>

                                  <div style={{ display: "grid", gap: 8 }}>
                                    {stationRows.map((row) => (
                                      <div
                                        key={row.id}
                                        style={{
                                          display: "flex",
                                          justifyContent: "space-between",
                                          alignItems: "center",
                                          gap: 10,
                                          padding: "10px 12px",
                                          borderRadius: 12,
                                          border: `1px solid ${COLORS.border}`,
                                          background: COLORS.soft,
                                          opacity: alreadySubmitted ? 0.75 : 1,
                                        }}
                                      >
                                        <div style={{ flex: 1 }}>
                                          <div style={{ fontWeight: 900, color: COLORS.text }}>
                                            {row.name}{" "}
                                            <span style={{ fontSize: 12, opacity: 0.75 }}>
                                              (
                                              {row.pool === "B"
                                                ? "B Pool"
                                                : row.pool === "C"
                                                ? "C Pool"
                                                : "A Pool"}
                                              )
                                            </span>
                                          </div>
                                        </div>

                                        <select
                                          value={clampMade(row.made)}
                                          disabled={alreadySubmitted || finalized}
                                          onChange={(e) =>
                                            setMade(
                                              currentRound,
                                              stNum,
                                              row.id,
                                              Number(e.target.value)
                                            )
                                          }
                                          style={{
                                            ...inputStyle,
                                            width: 90,
                                            background: "#fff",
                                            fontWeight: 900,
                                            textAlign: "center",
                                          }}
                                        >
                                          {[0, 1, 2, 3, 4].map((m) => (
                                            <option key={m} value={m}>
                                              {m} made
                                            </option>
                                          ))}
                                        </select>

                                        <div
                                          style={{
                                            width: 90,
                                            textAlign: "right",
                                            fontWeight: 900,
                                            color: COLORS.navy,
                                          }}
                                        >
                                          {row.pts} pts
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <div style={{ fontWeight: 900, color: COLORS.navy, marginBottom: 8 }}>
                          Round {currentRound} Totals (This Card)
                        </div>

                        <div style={{ display: "grid", gap: 8 }}>
                          {cardPlayers.map((p) => {
                            const total = roundTotalForPlayer(currentRound, p.id);
                            return (
                              <div
                                key={p.id}
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: 12,
                                  border: `1px solid ${COLORS.border}`,
                                  background: "#fff",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div style={{ fontWeight: 900 }}>
                                  {p.name}{" "}
                                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                                    (
                                    {p.pool === "B"
                                      ? "B Pool"
                                      : p.pool === "C"
                                      ? "C Pool"
                                      : "A Pool"}
                                    )
                                  </span>
                                </div>
                                <div style={{ fontWeight: 900, color: COLORS.navy }}>
                                  {total} pts
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <button
                          onClick={() => submitCardScores(card.id)}
                          disabled={alreadySubmitted || finalized}
                          style={{
                            ...buttonStyle,
                            width: "100%",
                            background: alreadySubmitted ? "#ddd" : COLORS.green,
                            color: alreadySubmitted ? "#444" : "white",
                            border: `1px solid ${alreadySubmitted ? "#ddd" : COLORS.green}`,
                          }}
                          title="Only works when every station has a score for every player (0 is allowed)"
                        >
                          {alreadySubmitted ? "Card Submitted (Locked)" : "Submit Card Scores"}
                        </button>

                        <div
                          style={{
                            marginTop: 8,
                            fontSize: 12,
                            opacity: 0.75,
                            textAlign: "center",
                          }}
                        >
                          Submitting locks this card for this round and is required before the
                          admin can begin the next round or finalize.
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                  Select your card to start scoring.
                </div>
              )}
            </div>
          ) : null}

          {/* LEADERBOARDS (single toggle; all pools shown together) */}
      <div style={{ textAlign: "left" }}>
  <div
    onClick={() => setLeaderboardsOpen((v) => !v)}
    style={{
      fontWeight: 900,
      color: COLORS.navy,
      marginBottom: 8,
      cursor: "pointer",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
      padding: "10px 12px",
      borderRadius: 14,
      border: `1px solid ${COLORS.border}`,
      background: "#fff",
    }}
  >
    <span>Leaderboards (Cumulative)</span>
    <span style={{ fontSize: 12, opacity: 0.75 }}>
      {leaderboardsOpen ? "Tap to hide" : "Tap to show"}
    </span>
  </div>

  {leaderboardsOpen && (
    <div style={{ display: "grid", gap: 10 }}>
      {["A", "B", "C"].map((k) => {
        const label = k === "A" ? "A Pool" : k === "B" ? "B Pool" : "C Pool";
        const rows = leaderboardByPool[k] || [];

        return (
          <div
            key={k}
            style={{
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              background: "#fff",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "12px 12px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                background: COLORS.soft,
              }}
            >
              <div style={{ fontWeight: 900, color: COLORS.navy }}>
                {label}{" "}
                <span style={{ fontSize: 12, opacity: 0.75 }}>({rows.length})</span>
              </div>
            </div>

            <div style={{ padding: 12 }}>
              {rows.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  No players in this pool yet.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {rows.map((r, idx) => (
                    <div
                      key={r.id}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 12,
                        border: `1px solid ${COLORS.border}`,
                        background: COLORS.soft,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <div
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 12,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 900,
                            color: "white",
                            background: idx === 0 ? COLORS.green : COLORS.navy,
                            flexShrink: 0,
                          }}
                        >
                          {idx + 1}
                        </div>

                        <div style={{ fontWeight: 900, color: COLORS.text }}>{r.name}</div>
                      </div>

                      <div style={{ fontWeight: 900, color: COLORS.navy }}>{r.total} pts</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  )}
</div>

<div style={{ marginTop: 18, fontSize: 12, opacity: 0.65, textAlign: "center" }}>
  Tip: Round 1 cards must be created before starting. After that, cards are auto-created
  each round based on the previous round’s totals.
</div>
</div>

"""Reglas de backgammon como las juega PlayStrategy, para que Alma sepa qué acciones puede mandar.

Copia de strategygames/backgammon (variant/Variant.scala): puntos 0–23 (L1=0…A1=11, A2=12…L2=23); el jugador 1 avanza
hacia índices bajos y saca fichas desde 0–5, el 2 al revés. Cada paso del turno es una acción aparte: "roll" (el
servidor tira), "e1j1" (mover), "s@j2" (entrar desde la barra), "^c1" (sacar ficha), "endturn". Con dos dados
distintos, PlayStrategy obliga a usar los dos si se puede (mirando un paso adelante) y si no, el mayor; se copia igual
para no mandarle una acción que rechace.
"""

FILES = "abcdefghijkl"
START = "5S,3,3s,1,5s,4,2S/5s,3,3S,1,5S,4,2s[] - - w 0 0 - 1"


def key(i: int) -> str:
    return f"{FILES[11 - i]}1" if i < 12 else f"{FILES[i - 12]}2"


def index(k: str) -> int:
    f = FILES.index(k[0])
    return 11 - f if k[1] == "1" else 12 + f


def direction(p: int) -> int:
    return -1 if p == 0 else 1


def bar_index(p: int) -> int:
    return 24 if p == 0 else -1


class Board:
    def __init__(self, fen: str = START):
        board, *rest = fen.split(" ")
        pocket = ""
        if "[" in board:
            board, pocket = board.split("[")
            pocket = pocket.rstrip("]")
        self.owner = [-1] * 24
        self.count = [0] * 24
        for row, base in zip(board.split("/"), (12, 11)):   # fila 2 de A2 a L2, luego fila 1 de A1 a L1
            col = 0
            for tok in row.split(","):
                if tok[-1] in "Ss":
                    i = base + col if base == 12 else base - col
                    self.owner[i], self.count[i] = (0 if tok[-1] == "S" else 1), int(tok[:-1])
                    col += 1
                else:
                    col += int(tok)
        self.bar = [0, 0]
        for tok in filter(None, pocket.split(",")):
            self.bar[0 if tok[-1] == "S" else 1] += int(tok[:-1])
        self.player = 0 if (rest[2] if len(rest) > 2 else "w") == "w" else 1
        self.off = [int(rest[3]), int(rest[4])] if len(rest) > 4 else [0, 0]
        self.dice: list[int] = []
        self.rolled = False
        self.started = False        # ya hubo alguna acción en la partida
        self.offer = False          # doblaje del cubo pendiente
        self._turn_stack: list = []

    def copy(self) -> "Board":
        b = Board.__new__(Board)
        b.owner, b.count, b.bar, b.off, b.dice = self.owner[:], self.count[:], self.bar[:], self.off[:], self.dice[:]
        b.player, b.rolled, b.started, b.offer, b._turn_stack = self.player, self.rolled, self.started, self.offer, []
        return b

    # ---- lo que dice Variant.scala ----

    def ended(self) -> bool:
        return 15 in self.off

    def mine(self, p: int) -> list[int]:
        return [i for i in range(24) if self.count[i] and self.owner[i] == p]

    def blocked(self, i: int) -> bool:
        return self.count[i] > 1 and self.owner[i] != self.player

    def all_home(self, p: int) -> bool:
        return not self.bar[p] and all((i < 6) if p == 0 else (i > 17) for i in self.mine(p))

    def furthest(self, p: int) -> int:
        m = self.mine(p)
        return 0 if not m else (max(m) + 1 if p == 0 else 24 - min(m))

    def _gen_moves(self) -> list[tuple]:
        p, out = self.player, []
        for i in self.mine(p):
            for d in sorted(set(self.dice)):
                j = i + direction(p) * d
                if 0 <= j < 24 and not self.blocked(j):
                    out.append(("move", i, j, d))
        return out

    def _gen_drops(self) -> list[tuple]:
        p, out = self.player, []
        for d in sorted(set(self.dice)):
            j = bar_index(p) + direction(p) * d
            if 0 <= j < 24 and not self.blocked(j):
                out.append(("drop", None, j, d))
        return out

    def _gen_lifts(self) -> list[tuple]:
        p, out = self.player, []
        for d in sorted(set(self.dice)):
            m = min(self.furthest(p), d)
            i = m - 1 if p == 0 else 24 - m
            if 0 <= i < 24 and self.count[i] and self.owner[i] == p:
                out.append(("lift", i, None, d))
        return out

    def _can_move(self) -> bool:
        return bool(self.dice) and not self.bar[self.player]

    def _can_drop(self) -> bool:
        return bool(self.dice) and bool(self.bar[self.player])

    def _can_lift(self) -> bool:
        return bool(self.dice) and self.all_home(self.player)

    def _continues(self, a: tuple) -> bool:
        s = self.after(a)
        return s.ended() or bool(s.valid_moves()) or bool(s.valid_lifts()) or bool(s.valid_drops())

    def _look_ahead(self, base: list[tuple], other_continues) -> list[tuple]:
        if len(set(self.dice)) != 2:
            return base
        cont = [a for a in base if self._continues(a)]
        if cont or other_continues():
            return cont
        top = max((a[3] for a in base), default=0)
        return [a for a in base if a[3] == top]

    def valid_moves(self) -> list[tuple]:
        if not self._can_move():
            return []
        lifts_go = lambda: self._can_lift() and any(self._continues(a) for a in self._gen_lifts())
        return self._look_ahead(self._gen_moves(), lifts_go)

    def valid_drops(self) -> list[tuple]:
        return self._look_ahead(self._gen_drops(), lambda: False) if self._can_drop() else []

    def valid_lifts(self) -> list[tuple]:
        if not self._can_lift():
            return []
        moves_go = lambda: self._can_move() and any(self._continues(a) for a in self._gen_moves())
        best: dict[int, tuple] = {}
        for a in self._look_ahead(self._gen_lifts(), moves_go):   # por casilla, el dado mayor
            if a[1] not in best or a[3] > best[a[1]][3]:
                best[a[1]] = a
        return list(best.values())

    def steps(self) -> list[tuple]:
        return self.valid_moves() + self.valid_drops() + self.valid_lifts()

    def can_end_turn(self) -> bool:
        return ((not self.dice or not self.steps()) and self.rolled) or not self.started

    def can_roll(self) -> bool:
        return not self.dice and not self.rolled and not self.offer

    # ---- aplicar ----

    def after(self, a: tuple) -> "Board":
        b = self.copy()
        b._apply(a)
        return b

    def _apply(self, a: tuple) -> None:
        kind, i, j, d = a
        p = self.player
        if i is not None:
            self.count[i] -= 1
            if not self.count[i]:
                self.owner[i] = -1
        else:
            self.bar[p] -= 1
        if j is not None:
            if self.count[j] and self.owner[j] != p:   # golpe: la ficha sola del rival va a la barra
                self.bar[1 - p] += 1
                self.count[j] = 0
            self.owner[j] = p
            self.count[j] += 1
        else:
            self.off[p] += 1
        self.dice.remove(d)

    @staticmethod
    def uci(a: tuple) -> str:
        kind, i, j, _ = a
        return {"move": lambda: key(i) + key(j), "drop": lambda: "s@" + key(j), "lift": lambda: "^" + key(i)}[kind]()

    def play(self, tok: str) -> None:
        """Aplica una acción tal como sale en "moves" de PlayStrategy."""
        tok = tok.strip().rstrip("x")
        if not tok:
            return
        if tok == "undo":
            if not self._turn_stack:
                raise ValueError("backgammon: undo sin nada que deshacer")
            st = self._turn_stack.pop()
            self.__dict__.update({k: v for k, v in st.__dict__.items() if k != "_turn_stack"})
            return
        snap = self.copy()
        if tok == "endturn":
            if not self.can_end_turn():
                raise ValueError("backgammon: endturn no válido")
            self.player, self.dice, self.rolled, self._turn_stack = 1 - self.player, [], False, []
            self.started = True
            return
        self.started = True
        if tok in ("cubeo", "cubey", "cuben"):
            self.offer = tok == "cubeo"
            return
        if "/" in tok:
            a, b = (int(x) for x in tok.split("/"))
            self.dice, self.rolled = ([a] * 4 if a == b else [a, b]), True
            self._turn_stack = []
            return
        want, cands = tok, self.steps()
        if len(tok) == 4 and tok[0] in "123456" and tok[1] == "^":   # sacar indicando el dado ("3^c1")
            want, d = tok[1:], int(tok[0])
            cands = [a for a in (self._gen_lifts() if self._can_lift() else []) if a[3] == d] or cands
        for a in cands:
            if self.uci(a) == want:
                self._turn_stack.append(snap)
                self._apply(a)
                return
        raise ValueError(f"backgammon: acción no válida {tok}")


def replay(moves: str, fen: str | None = None) -> Board:
    """moves: turnos separados por espacio, acciones del turno por coma (gameState de PlayStrategy)."""
    b = Board(fen if fen and fen != "startpos" else START)
    for turn in moves.split():
        for tok in turn.split(","):
            b.play(tok)
    return b


# ---- turnos completos para elegir ----

def turns(b: Board, limit: int = 4000) -> list[list[tuple]]:
    """Todas las secuencias de pasos hasta gastar los dados (sin repetir la posición final)."""
    seen, out = set(), []

    def walk(s: Board, path: list[tuple]):
        if len(out) >= limit:
            return
        nxt = s.steps() if s.dice else []
        if not nxt:
            sig = (tuple(s.owner), tuple(s.count), tuple(s.bar), tuple(s.off))
            if sig not in seen:
                seen.add(sig)
                out.append(path)
            return
        for a in nxt:
            walk(s.after(a), path + [a])

    walk(b, [])
    return out


def pips(b: Board, p: int) -> int:
    return sum((i + 1 if p == 0 else 24 - i) * b.count[i] for i in b.mine(p)) + 25 * b.bar[p]


def blots(b: Board, p: int) -> int:
    return sum(1 for i in b.mine(p) if b.count[i] == 1)


def points(b: Board, p: int) -> int:
    return sum(1 for i in b.mine(p) if b.count[i] >= 2)


def describe(b: Board, path: list[tuple]) -> dict:
    """Etiqueta en español y una nota simple para ordenar (más es mejor para quien mueve)."""
    p = b.player
    s = b
    for a in path:
        s = s.after(a)
    hits = s.bar[1 - p] - b.bar[1 - p]
    off = s.off[p] - b.off[p]
    parts = []
    if hits:
        parts.append(f"golpeas {hits}")
    if off:
        parts.append(f"sacas {off}")
    parts.append(f"quedas con {blots(s, p)} fichas solas y {points(s, p)} puntos hechos")
    score = 10 * hits + 8 * off + 3 * points(s, p) - 4 * blots(s, p) + (pips(b, p) - pips(s, p)) / 4
    steps = " ".join(Board.uci(a) for a in path) or "(no puedes mover)"
    return {"path": path, "label": f"{steps}: " + ", ".join(parts), "score": score}


def text(b: Board, me: int) -> str:
    """El tablero en texto para Haiku: cada punto desde tu lado (1 = tu casa más cercana a sacar)."""
    rows = []
    for i in range(24):
        if b.count[i]:
            who = "tú" if b.owner[i] == me else "dueño"
            dist = i + 1 if me == 0 else 24 - i
            rows.append(f"{key(i)} (tu punto {dist}): {b.count[i]} de {who}")
    return ("\n".join(rows) + f"\nBarra: tú {b.bar[me]}, dueño {b.bar[1 - me]}. Fuera: tú {b.off[me]}, dueño {b.off[1 - me]}."
            f"\nPips que te faltan: {pips(b, me)}; al dueño: {pips(b, 1 - me)}. Dados: {b.dice}")

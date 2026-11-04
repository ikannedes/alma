"""Reglas de oware (abapa) como las juega PlayStrategy, para que Alma sepa qué jugadas puede mandar.

Copia de las reglas de su motor (Joan Sala, OwareGame.java, que usa strategygames/samurai): casas 0–5 son las del
Sur (a1–f1, jugador 1), 6–11 las del Norte (f2…a2); se siembra en sentido contrario al reloj saltando la casa de
origen; se capturan, hacia atrás desde la última casa del rival, las que quedan con 2 o 3; si la captura dejaría al
rival sin semillas (gran slam) no se captura nada; si el rival no tiene semillas hay que darle. La partida acaba con más
de 24 capturadas o cuando el que tiene turno no puede mover (cada quien se queda con lo de su lado).

PlayStrategy escribe las jugadas como casa de origen + casa donde cae la última semilla ("a1e1").
"""

N = 12
GOAL = 24


def key(i: int) -> str:
    return f"{'abcdef'[i]}1" if i < 6 else f"{'abcdef'[11 - i]}2"


def index(k: str) -> int:
    f = ord(k[0]) - 97
    return f if k[1] == "1" else 11 - f


def dest(i: int, seeds: int) -> int:
    return (seeds + i + (seeds - 1) // 11) % N


class Board:
    def __init__(self):
        self.pits = [4] * N
        self.store = [0, 0]   # Sur, Norte
        self.turn = 0         # 0 Sur (p1), 1 Norte (p2)

    def copy(self) -> "Board":
        b = Board()
        b.pits, b.store, b.turn = self.pits[:], self.store[:], self.turn
        return b

    @staticmethod
    def side(p: int) -> range:
        return range(0, 6) if p == 0 else range(6, 12)

    def seeds_of(self, p: int) -> int:
        return sum(self.pits[i] for i in self.side(p))

    def legal(self) -> list[int]:
        mine = [i for i in self.side(self.turn) if self.pits[i]]
        if self.seeds_of(1 - self.turn):
            return mine
        right = 5 if self.turn == 0 else 11
        return [i for i in mine if i + self.pits[i] > right]   # hay que darle al rival

    def ended(self) -> bool:
        return max(self.store) > GOAL or not self.legal()

    def outcome(self) -> int | None:
        """Ganador al acabar (0 Sur, 1 Norte, -1 empate); None si sigue."""
        if not self.ended():
            return None
        totals = [self.store[p] + (0 if max(self.store) > GOAL else self.seeds_of(p)) for p in (0, 1)]
        return -1 if totals[0] == totals[1] else int(totals[1] > totals[0])

    def play(self, i: int) -> int:
        """Juega la casa i y devuelve cuántas semillas capturó."""
        if i not in self.legal():
            raise ValueError(f"oware: jugada ilegal {key(i)}")
        seeds, self.pits[i], h = self.pits[i], 0, i
        while seeds:
            h = (h + 1) % N
            if h != i:
                self.pits[h] += 1
                seeds -= 1
        rival = self.side(1 - self.turn)
        taken = []
        while h in rival and self.pits[h] in (2, 3):
            taken.append(h)
            h -= 1
        got = 0
        if taken and sum(self.pits[k] for k in rival if k not in taken):   # gran slam: no captura
            got = sum(self.pits[k] for k in taken)
            for k in taken:
                self.pits[k] = 0
            self.store[self.turn] += got
        self.turn = 1 - self.turn
        return got

    def uci(self, i: int) -> str:
        return key(i) + key(dest(i, self.pits[i]))

    def play_uci(self, u: str) -> int:
        i = index(u[:2])
        if self.uci(i) != u[:4]:
            raise ValueError(f"oware: {u} no cae donde dice")
        return self.play(i)

    def text(self, me: int) -> str:
        """El tablero visto por Alma (sus casas abajo)."""
        top = [key(i) for i in range(11, 5, -1)]
        bot = [key(i) for i in range(6)]
        if me == 1:
            top, bot = [key(i) for i in range(5, -1, -1)], [key(i) for i in range(6, 12)]
        row = lambda ks: " ".join(f"{k}:{self.pits[index(k)]:>2}" for k in ks)
        return (f"Rival (dueño):  {row(top)}\nTú (Alma):      {row(bot)}\n"
                f"Capturadas: tú {self.store[me]}, dueño {self.store[1 - me]} (gana quien pase de 24)")


def replay(moves: list[str]) -> Board:
    b = Board()
    for u in moves:
        b.play_uci(u)
    return b


def options(b: Board) -> list[dict]:
    """Jugadas posibles con lo que pasa en cada una (para que Haiku elija con sentido)."""
    out = []
    for i in b.legal():
        after = b.copy()
        got = after.play(i)
        threat = max((after.copy().play(j) for j in after.legal()), default=0)
        desc = f"{key(i)} ({b.pits[i]} semillas, la última cae en {key(dest(i, b.pits[i]))})"
        if got:
            desc += f", capturas {got}"
        if threat:
            desc += f"; después el dueño puede capturarte hasta {threat}"
        out.append({"uci": b.uci(i), "label": desc, "gain": got - threat})
    return out

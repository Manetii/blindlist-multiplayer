-- ════════════════════════════════════════════════════════════════
--  005 — Point de départ de la lecture
-- ════════════════════════════════════════════════════════════════
--
--  Jusqu'ici l'heuristique était câblée : chaque morceau démarrait à
--  25 % de sa durée, plafonné à 50 s. C'est le bon défaut pour un blind
--  test — l'intro est souvent muette ou trop reconnaissable — mais pas
--  toujours souhaitable. Une soirée peut vouloir jouer les intros,
--  justement parce qu'elles sont la partie la plus identifiable.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE parties
  ADD COLUMN start_at_key_moment boolean NOT NULL DEFAULT true;

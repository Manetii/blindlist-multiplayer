-- ════════════════════════════════════════════════════════════════
--  006 — Point de départ réglable finement
-- ════════════════════════════════════════════════════════════════
--
--  La 005 avait rendu le saut d'intro activable. Un booléen ne dit
--  pourtant qu'une chose : « 25 %, ou rien ». Or 25 % n'est le bon
--  réglage que pour une structure de chanson classique — sur un titre
--  à intro longue, on tombe encore dedans ; sur un morceau court, on
--  arrive déjà au refrain.
--
--  Un pourcentage remplace le booléen sans rien perdre : 0 exprime
--  exactement l'ancien `false`. Une case à cocher de moins, un curseur
--  à la place.
--
--  Le plafond à 50 % n'est pas cosmétique : au-delà, sur un morceau de
--  deux minutes, on démarre dans le refrain final — c'est-à-dire qu'on
--  donne la réponse.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE parties
  ADD COLUMN key_moment_pct smallint NOT NULL DEFAULT 25
    CONSTRAINT key_moment_pct_range CHECK (key_moment_pct BETWEEN 0 AND 50);

-- Reprise de l'ancien réglage : false devient « au début », true garde
-- la valeur qui était câblée dans skipIntroOffsetMs().
UPDATE parties
   SET key_moment_pct = CASE WHEN start_at_key_moment THEN 25 ELSE 0 END;

ALTER TABLE parties DROP COLUMN start_at_key_moment;

-- ════════════════════════════════════════════════════════════════
--  003 — Options de partie
-- ════════════════════════════════════════════════════════════════
--
--  La v1 rendait les règles R2 et R3 activables par l'hôte. La v2
--  n'avait porté que R3 (rule_trapper_enabled), et R2 était câblée en
--  dur — impossible de jouer sans la règle du bluffeur.
--
--  On stocke ces réglages EN BASE plutôt qu'en localStorage : ce sont
--  des propriétés de la soirée, pas du navigateur. Deux parties
--  successives peuvent avoir des règles différentes, et l'hôte qui
--  change de poste retrouve les siennes.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE parties
  -- R2 — Bluffeur : +1 au joueur désigné à tort, par vote erroné reçu.
  -- Activée par défaut, comme en v1.
  ADD COLUMN rule_bluffer_enabled boolean NOT NULL DEFAULT true,

  -- Masquer titre, artiste et pochette au démarrage de chaque manche.
  -- L'hôte les révèle d'un geste pour la mise en scène.
  ADD COLUMN hide_indices_default boolean NOT NULL DEFAULT true;

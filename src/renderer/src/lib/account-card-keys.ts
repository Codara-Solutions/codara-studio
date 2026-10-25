/**
 * The ids an account card can be drawn from. A card is one account with two
 * halves, a Cora row and a terminal profile, and the list sees whichever
 * halves the two stores reported.
 */
export interface AccountCardIdentity {
  key: string;
  provider: string;
  coraProfileId?: string;
  cliProfileId?: string;
}

/**
 * Gives every card the key its account was first drawn with. The key built
 * from the ids depends on which half answered: a terminal-only half while
 * the Cora status read is failing becomes a Cora row once it answers, and a
 * terminal-only half that is shared gains a row. Neither id alone survives
 * every such step, so `known` remembers each id's key and a card that shares
 * an id with an earlier card keeps that card's key. A changed key remounts
 * the card and drops its open menu, rename form, or remove confirmation.
 *
 * `known` belongs to one list and is updated in place. Keys stay unique
 * within one call: a remembered key another card already took is not reused.
 */
export function stableAccountCardKeys<T extends AccountCardIdentity>(
  cards: ReadonlyArray<T>,
  known: Map<string, string>,
): T[] {
  const used = new Set<string>();
  const idsOf = (card: T): string[] => [
    ...(card.coraProfileId ? [`${card.provider}:cora:${card.coraProfileId}`] : []),
    ...(card.cliProfileId ? [`${card.provider}:cli:${card.cliProfileId}`] : []),
  ];
  // Fresh keys are claimed first, so a remembered key can never collide with
  // a card that is being drawn under its own ids.
  const fresh = new Set(cards.map((card) => card.key));
  return cards.map((card) => {
    const ids = idsOf(card);
    const remembered = ids
      .map((id) => known.get(id))
      .find(
        (key): key is string =>
          key !== undefined && !used.has(key) && (key === card.key || !fresh.has(key)),
      );
    const key = remembered ?? card.key;
    used.add(key);
    for (const id of ids) known.set(id, key);
    return key === card.key ? card : { ...card, key };
  });
}

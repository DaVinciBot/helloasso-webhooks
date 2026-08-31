/**
 * Identités : normalisation, et la question « de qui parle ce paiement ? ».
 *
 * Tout est pur et sans dépendance : ces fonctions sont ce qui permet au service
 * de reconnaître une même personne écrite par deux humains différents.
 */

/** Personne telle que HelloAsso la connaît, réduite à ce que le service lit. */
export interface Person {
	readonly email?: string | undefined;
	readonly firstName?: string | undefined;
	readonly lastName?: string | undefined;
}

/**
 * Normalisation d'email : minuscules et espaces retirés. Renvoie `undefined` si
 * la valeur ne peut pas servir de clé de recherche — l'appelant décide alors
 * quoi en faire.
 */
export function normalizeEmail(email: string | undefined): string | undefined {
	if (email === undefined) {
		return undefined;
	}
	const normalized = email.trim().toLowerCase();
	if (normalized === '' || !normalized.includes('@')) {
		return undefined;
	}
	return normalized;
}

/**
 * Séparateurs internes aux noms propres : apostrophe droite, apostrophe
 * typographique, trait d'union. « D'Artagnan », « D’Artagnan » et
 * « D Artagnan » désignent la même personne.
 */
const NAME_SEPARATORS = /[’'-]/g;

/**
 * Normalisation d'un prénom ou d'un nom.
 *
 * Une personne saisit son nom chez HelloAsso, un autre humain l'a saisi dans
 * Notion : la casse, les accents, les traits d'union et les apostrophes ne
 * concordent qu'au hasard. On compare donc des formes réduites — « DUPONT »,
 * « Dupont » et « du-pont » deviennent la même clé. Renvoie `undefined` si la
 * valeur ne peut pas servir de critère.
 *
 * La décomposition NFD sépare chaque lettre accentuée de son accent, que
 * `\p{Diacritic}` retire ensuite : « é » devient « e ».
 */
export function normalizeName(name: string | undefined): string | undefined {
	if (name === undefined) {
		return undefined;
	}
	const normalized = name
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(NAME_SEPARATORS, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return normalized === '' ? undefined : normalized;
}

/**
 * Met un prénom et un nom en forme pour l'affichage humain : espaces normalisés,
 * accents et casse d'origine conservés. C'est cette forme qui part sur Discord
 * et qui est stockée au registre — la forme normalisée, elle, ne sert qu'à
 * comparer.
 */
export function displayName(firstName: string, lastName: string): string {
	return `${firstName} ${lastName}`.replace(/\s+/g, ' ').trim();
}

/** Deux personnes portent-elles le même nom, à la normalisation près ? */
export function sameName(left: Person | undefined, right: Person | undefined): boolean {
	const leftFirst = normalizeName(left?.firstName);
	const leftLast = normalizeName(left?.lastName);
	return (
		leftFirst !== undefined &&
		leftLast !== undefined &&
		leftFirst === normalizeName(right?.firstName) &&
		leftLast === normalizeName(right?.lastName)
	);
}

/** Critères de recherche de la ligne du membre. */
export interface MemberIdentity {
	readonly email: string | undefined;
	readonly firstName: string | undefined;
	readonly lastName: string | undefined;
}

/**
 * Critères d'appariement du membre, à partir du payeur et de la personne
 * inscrite.
 *
 * L'identité vient de l'inscrit dès qu'elle est exploitable, du payeur sinon —
 * mieux vaut un repli que pas de critère du tout.
 *
 * L'email, lui, n'existe que côté payeur : le formulaire ne demande à l'inscrit
 * qu'un prénom et un nom. Le retenir sans réserve reviendrait, quand un tiers
 * règle la cotisation, à marquer payée la ligne *du payeur* : l'erreur est
 * silencieuse et touche deux membres à la fois. On ne le garde donc que
 * lorsqu'il désigne bien l'inscrit — noms concordants, ou aucune identité
 * d'inscrit connue.
 */
export function memberIdentity(
	payer: Person | undefined,
	registrant: Person | undefined
): MemberIdentity {
	const known =
		normalizeName(registrant?.firstName) !== undefined &&
		normalizeName(registrant?.lastName) !== undefined;
	const samePerson = !known || sameName(registrant, payer);

	return {
		email: samePerson ? normalizeEmail(payer?.email) : undefined,
		firstName: known ? registrant?.firstName : payer?.firstName,
		lastName: known ? registrant?.lastName : payer?.lastName
	};
}

/**
 * Mention du payeur dans une alerte, quand il n'est pas la personne concernée :
 * sans elle, une alerte sur un règlement par un tiers ne donne aucune prise pour
 * retrouver le paiement côté HelloAsso. Renvoie `undefined` quand la mentionner
 * n'apprendrait rien.
 */
export function describePayer(
	payer: Person | undefined,
	member: { readonly firstName: string | undefined; readonly lastName: string | undefined }
): string | undefined {
	const identity = [payer?.firstName, payer?.lastName].filter((part) => part !== undefined);

	if (sameName(payer, member) || (identity.length === 0 && payer?.email === undefined)) {
		return undefined;
	}

	const email = payer?.email === undefined ? undefined : `<${payer.email}>`;
	return [...identity, email].filter((part) => part !== undefined).join(' ');
}

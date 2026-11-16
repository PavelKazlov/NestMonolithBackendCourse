/**
 * Категория отказа при проверке токена (спека 1.2, раздел 1.5):
 * «Причина JWT журналируется категорией missing, malformed, signature,
 * expired, claims, token_use или user_inactive, но наружу возвращается
 * общая ошибка».
 *
 * Зачем категория в журнале: всплеск `signature` значит, что кто-то подделывает
 * токены или ключ сменили без перевыпуска; всплеск `expired` — клиент не
 * вызывает refresh. Зачем ОДНА ошибка наружу: подробности помогли бы
 * атакующему понять, какая часть подделки «почти сработала».
 */
export type TokenFailureCategory =
  | 'missing'
  | 'malformed'
  | 'signature'
  | 'expired'
  | 'claims'
  | 'token_use'
  | 'user_inactive';

/**
 * Внутренняя ошибка проверки токена. Наружу не выходит: её ловят
 * SessionService/AccessGuard, пишут категорию в аудит и бросают
 * общий 401 `invalid_session`.
 */
export class TokenVerificationError extends Error {
  constructor(readonly category: TokenFailureCategory) {
    super(`Token rejected: ${category}`);
    this.name = 'TokenVerificationError';
  }
}

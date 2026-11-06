// Portuguese system prompt for the WhatsApp message classifier — translated
// from es.ts. Keep this file's
// rule structure (delete / pago_cuota / query / the 5 noteType rules) in
// exact sync with es.ts and en.ts whenever one of them changes.
//
// Ruling (controller, see task-5-brief.md's note at the top): the 6
// EXPENSE_CATEGORIES names stay in Spanish here too — only the
// instructional prose around the list is translated to Portuguese. See
// es.ts's header comment for why.
import { config } from "../../config";
import { EXPENSE_CATEGORIES } from "../../expenseCategories";
import { toArgentinaIsoString } from "../../timezone";

const CATEGORY_LIST = EXPENSE_CATEGORIES.map((c) => `"${c}"`).join(", ");

export function buildSystemPrompt(nowIso: string, timezone: string, utcOffset: string): string {
  return `Você é um classificador de mensagens para um app pessoal de notas por WhatsApp (gastos, ideias e lembretes).

O fuso horário do usuário é ${timezone} (UTC${utcOffset}, sem horário de verão). Todo horário mencionado ("às 10", "amanhã de tarde") é no horário desse fuso.

A data e hora atuais de referência são ${toArgentinaIsoString(new Date(nowIso))} (no horário do fuso do usuário; equivalente a ${nowIso} em UTC). Resolva toda data ou horário relativo mencionado na mensagem (incluindo referências ambíguas a dias da semana, como "na sexta" sem esclarecer qual) SEMPRE para a próxima ocorrência futura a partir dessa referência — nunca para uma ocorrência passada.

Responda EXCLUSIVAMENTE com um objeto JSON (sem texto adicional, sem markdown, sem explicações) com este formato:
{
  "intent": "capture" | "query" | "delete" | "pago_cuota" | "factibilidad_compra" | "retiro_ahorro" | "proyeccion_ahorro",
  "noteType": "gasto" | "idea" | "recordatorio" | "ingreso" | "ahorro" | "no_identificado",
  "amountCents": number,
  "category": string,
  "currency": string,
  "parsedDatetime": string | null,
  "isSalary": boolean
}

Regras:
- "intent" é "delete" quando a mensagem pede para apagar/excluir/remover algo que já foi anotado antes (por exemplo "apaga isso", "exclui a ideia do app de livros", "apaga o lembrete do dentista", "apaga essa" em resposta a uma consulta anterior). Nunca é "delete" quando a mensagem fala de apagar outra coisa que não é uma nota própria (por exemplo "preciso apagar umas mensagens antigas do celular" continua sendo "capture" com o "noteType" correspondente). Quando "intent" é "delete" nenhum outro campo é necessário.
- "intent" é "pago_cuota" quando a mensagem diz que algo foi pago/liquidado/quitado e parece ser uma conta, serviço ou cartão já conhecido, SEM descrever uma compra pontual nova (ex.: "paguei a academia", "paguei o cartão mastercard", "quitei o visa"). Se a mensagem descreve uma compra ou gasto pontual (com ou sem valor), continua sendo "capture"/"gasto" como de costume. Quando "intent" é "pago_cuota", pode-se incluir "amountCents" se a mensagem mencionar um valor explícito (ex.: "paguei o cartão mastercard, 85000"); se não mencionar, o campo é omitido.
- "intent" é "factibilidad_compra" quando a mensagem pergunta se vale a pena ou é viável comprar algo, financiar em parcelas, ou pagar à vista, comparando com as finanças do usuário (ex.: "posso comprar algo de $300.000 em 6 parcelas sem que me afete muito?", "quero uma moto de $X, entrada de $Y, financio o resto a uma taxa Z, vale a pena?"). É diferente de "query": aqui não se pergunta sobre notas já salvas, mas se avalia uma compra hipotética contra receitas/gastos/parcelas reais. Quando "intent" é "factibilidad_compra" nenhum outro campo é necessário — o resto dos detalhes da compra é extraído separadamente.
- "intent" é "retiro_ahorro" quando a mensagem diz que o usuário gastou/usou/retirou dinheiro da sua poupança já guardada (ex.: "gastei minha poupança na TV, 400000", "usei 100000 da minha poupança"). Se não mencionar um valor, assume-se que retira tudo o que tem guardado. Nunca é "gasto" — não descreve uma compra nova com dinheiro que não estava já guardado. Quando "intent" é "retiro_ahorro", pode-se incluir "amountCents" se a mensagem mencionar um valor explícito; se não mencionar, o campo é omitido.
- "intent" é "proyeccion_ahorro" quando a mensagem pergunta quanto o usuário pode economizar ou guardar da receita, sem mencionar uma compra pontual (ex.: "quanto posso economizar no mês que vem?", "quanto me sobra para guardar?"). Diferente de "factibilidad_compra": aqui não há nada para comprar.
- "intent" é "query" apenas se a mensagem for uma pergunta sobre notas salvas anteriormente (por exemplo "quanto gastei este mês?" ou "o que anotei na terça?"). Em qualquer outro caso que não seja "delete", "pago_cuota", "retiro_ahorro", "factibilidad_compra" ou "proyeccion_ahorro", é "capture".
- Se "intent" for "capture", inclua "noteType":
  - "gasto": a mensagem descreve um gasto de dinheiro. Inclua "amountCents" (o valor em centavos da moeda do gasto, por exemplo "3200 pesos" -> 320000, "u$s 50" -> 5000), "category" (escolha EXATAMENTE uma destas 6 categorias, exatamente como estão escritas, e nunca invente outra: ${CATEGORY_LIST}) e "currency": o código ISO de 3 letras da moeda. O padrão é "${config.defaultCurrency}"; use outro código SOMENTE se a mensagem mencionar explicitamente outra moeda (por exemplo "u$s", "usd", "dólares" -> "USD"; "euros" -> "EUR"). Nunca converta valores entre moedas.
  - "idea": uma ideia ou pensamento para lembrar depois, sem valor nem data associados.
  - "recordatorio": algo para lembrar numa data/horário concreto ou resolúvel. Inclua "parsedDatetime" como data e hora ISO 8601 completa já resolvida para o futuro, no horário do fuso do usuário e SEMPRE com o offset explícito ${utcOffset} no final (por exemplo "2026-11-04T15:00:00${utcOffset}"). Nunca use "Z" nem omita o offset. Se não for possível determinar uma data concreta, use null.
  - "ingreso": dinheiro que o usuário recebeu (não gastou). Inclua "amountCents" e "currency" com o mesmo critério de "gasto". Inclua "isSalary": true apenas se a mensagem mencionar explicitamente a palavra "salário" (ex.: "recebi o salário", "caiu meu salário"); em qualquer outro tipo de receita (ex.: "recebi um dinheiro", "me devolveram 5000", "me pagaram um trabalho extra"), "isSalary": false.
  - "ahorro": dinheiro que o usuário JÁ TINHA e decide guardar (não é dinheiro novo que entrou, como "ingreso"; não é dinheiro que saiu para pagar algo, como "gasto"). Frases típicas: "separei $X este mês", "guardei $X", "poupei $X". Inclua "amountCents" com o mesmo critério de "gasto"/"ingreso".
  - "no_identificado": se não for possível determinar com confiança nenhum dos anteriores.
- Não inclua no JSON os campos que não correspondam ao tipo detectado.`;
}

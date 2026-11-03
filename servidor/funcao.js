// electron/pagamentos/mercadopago.js
var ErroPagamento = class extends Error {};
const BASE = "https://api.mercadopago.com";
const r2$1 = (n) => Math.round(Number(n) * 100) / 100;
/** Data com o fuso de Maceió no formato que o Mercado Pago pede: 2026-11-01T14:30:00.000-03:00 */
function dataMP(d) {
	return (/* @__PURE__ */ new Date(d.getTime() - 108e5)).toISOString().replace("Z", "-03:00");
}
function traduzir(dados, status) {
	const causa = dados?.cause?.[0]?.description ?? dados?.cause?.[0]?.code;
	const msg = dados?.message ?? dados?.error ?? `erro ${status}`;
	if (/payer.*email|email.*payer/i.test(`${msg} ${causa ?? ""}`)) return "e-mail do pagador recusado. Em Configurações › Mercado Pago, use um e-mail válido e diferente do e-mail da sua conta.";
	if (/collector|pix.*key|key.*pix|without key/i.test(`${msg} ${causa ?? ""}`)) return "a conta ainda não tem chave Pix cadastrada no Mercado Pago. Cadastre uma chave no app do Mercado Pago e tente de novo.";
	return causa ? `${msg} (${causa})` : msg;
}
function criarMercadoPago({ obterToken, base = BASE, enviar = (...a) => fetch(...a), relogio = () => /* @__PURE__ */ new Date() }) {
	async function pedir(metodo, caminho, { corpo, token, chave, cabecalhos = {} } = {}) {
		const t = token ?? await obterToken();
		if (!t) throw new ErroPagamento("Cadastre o Access Token do Mercado Pago em Configurações › Mercado Pago.");
		let r;
		try {
			r = await enviar(base + caminho, {
				method: metodo,
				headers: {
					Authorization: `Bearer ${t}`,
					"Content-Type": "application/json",
					...chave ? { "X-Idempotency-Key": chave } : {},
					...cabecalhos
				},
				body: corpo ? JSON.stringify(corpo) : void 0,
				signal: AbortSignal.timeout(2e4)
			});
		} catch {
			throw new ErroPagamento("Sem conexão com o Mercado Pago. Confira a internet do computador e tente de novo, ou receba o Pix do jeito manual.");
		}
		let dados = null;
		try {
			dados = await r.json();
		} catch {}
		if (r.status === 401 || r.status === 403) throw new ErroPagamento("O Mercado Pago recusou o Access Token. Confira se copiou o token certo em Suas integrações › Credenciais.");
		if (!r.ok) throw new ErroPagamento(`Mercado Pago: ${traduzir(dados, r.status)}`);
		return dados;
	}
	return {
		simulado: false,
		ambienteDoToken: (t) => String(t ?? "").startsWith("TEST-") ? "teste" : "producao",
		async conta(token) {
			const u = await pedir("GET", "/users/me", { token });
			return {
				id: u.id,
				apelido: u.nickname ?? u.first_name ?? String(u.id),
				email: u.email ?? null,
				pais: u.site_id ?? null
			};
		},
		async criarPix({ valor, descricao, referencia, email, chave, minutos = 30, notificacao = null }) {
			const expira = new Date(relogio().getTime() + Math.max(30, minutos) * 6e4);
			const d = await pedir("POST", "/v1/payments", {
				chave,
				corpo: {
					transaction_amount: r2$1(valor),
					description: descricao,
					payment_method_id: "pix",
					external_reference: referencia,
					date_of_expiration: dataMP(expira),
					payer: { email },
					...notificacao ? { notification_url: notificacao } : {}
				}
			});
			const td = d?.point_of_interaction?.transaction_data ?? {};
			if (!td.qr_code) throw new ErroPagamento("O Mercado Pago não devolveu o QR Code. Confira se a conta tem chave Pix cadastrada.");
			return {
				mp_id: String(d.id),
				status_mp: d.status,
				detalhe: d.status_detail ?? null,
				qr_code: td.qr_code,
				qr_imagem: td.qr_code_base64 ? `data:image/png;base64,${td.qr_code_base64}` : null,
				expira_em: d.date_of_expiration ? new Date(d.date_of_expiration).toISOString() : expira.toISOString()
			};
		},
		async consultar(mpId) {
			const d = await pedir("GET", `/v1/payments/${encodeURIComponent(mpId)}`);
			return {
				status_mp: d.status,
				detalhe: d.status_detail ?? null,
				aprovado_em: d.date_approved ?? null
			};
		},
		/** Pagamento completo (usado pelo aviso automático do Mercado Pago para achar o pedido pela referência). */
		async buscarPagamento(mpId) {
			const d = await pedir("GET", `/v1/payments/${encodeURIComponent(mpId)}`);
			return {
				mp_id: String(d.id),
				referencia: d.external_reference ?? null,
				status_mp: d.status,
				tipo: d.payment_type_id ?? null
			};
		},
		async cancelar(mpId) {
			return { status_mp: (await pedir("PUT", `/v1/payments/${encodeURIComponent(mpId)}`, { corpo: { status: "cancelled" } })).status };
		},
		/** Cria a página de pagamento do pedido. O site nunca recebe o número do cartão. */
		async criarPreferencia({ itens, referencia, email, nome, parcelas = 1, urls = null, notificacao = null, minutos = 60, chave }) {
			const agora = relogio();
			const d = await pedir("POST", "/checkout/preferences", {
				chave,
				corpo: {
					items: itens.map((i) => ({
						id: i.codigo ?? void 0,
						title: String(i.nome).slice(0, 250),
						quantity: 1,
						unit_price: r2$1(i.total),
						currency_id: "BRL"
					})),
					payer: {
						email,
						...nome ? { name: nome } : {}
					},
					external_reference: referencia,
					payment_methods: {
						installments: Math.min(12, Math.max(1, parcelas)),
						excluded_payment_types: [{ id: "ticket" }]
					},
					expires: true,
					expiration_date_from: dataMP(agora),
					expiration_date_to: dataMP(new Date(agora.getTime() + minutos * 6e4)),
					...urls ? {
						back_urls: urls,
						auto_return: "approved"
					} : {},
					...notificacao ? { notification_url: notificacao } : {}
				}
			});
			return {
				pref_id: String(d.id),
				link: d.init_point ?? d.sandbox_init_point ?? null,
				link_teste: d.sandbox_init_point ?? null
			};
		},
		/** Último pagamento feito para a referência (o site consulta até aprovar, sem precisar de webhook). */
		async buscarPorReferencia(referencia) {
			const lista = (await pedir("GET", `/v1/payments/search?external_reference=${encodeURIComponent(referencia)}&sort=date_created&criteria=desc&limit=5`))?.results ?? [];
			const p = lista.find((x) => ["approved", "authorized"].includes(x.status)) ?? lista[0];
			if (!p) return null;
			return {
				mp_id: String(p.id),
				status_mp: p.status,
				detalhe: p.status_detail ?? null,
				aprovado_em: p.date_approved ?? null,
				parcelas: p.installments ?? null,
				bandeira: p.payment_method_id ?? null,
				forma: p.payment_type_id === "debit_card" ? "cartao_debito" : p.payment_type_id === "credit_card" ? "cartao_credito" : p.payment_type_id ?? null
			};
		},
		async listarTerminais() {
			return ((await pedir("GET", "/terminals/v1/list?limit=50"))?.data?.terminals ?? []).map((t) => ({
				id: t.id,
				modo: t.operating_mode ?? null,
				loja: t.store_id ?? null,
				caixa: t.pos_id ?? null,
				caixa_externo: t.external_pos_id ?? null
			}));
		},
		async ativarPDV(terminal) {
			return { modo: (await pedir("PATCH", "/terminals/v1/setup", { corpo: { terminals: [{
				id: terminal,
				operating_mode: "PDV"
			}] } }))?.terminals?.[0]?.operating_mode ?? "PDV" };
		},
		async criarOrdemPoint({ valor, terminal, tipo, referencia, chave, minutos = 10 }) {
			return lerOrdem(await pedir("POST", "/v1/orders", {
				chave,
				corpo: {
					type: "point",
					external_reference: referencia,
					expiration_time: `PT${Math.min(180, Math.max(1, minutos))}M`,
					transactions: { payments: [{ amount: r2$1(valor).toFixed(2) }] },
					config: {
						point: {
							terminal_id: terminal,
							print_on_terminal: "seller_ticket"
						},
						...tipo ? { payment_method: { default_type: tipo === "debito" ? "debit_card" : "credit_card" } } : {}
					}
				}
			}));
		},
		async consultarOrdem(orderId) {
			return lerOrdem(await pedir("GET", `/v1/orders/${encodeURIComponent(orderId)}`));
		},
		async cancelarOrdem(orderId) {
			return lerOrdem(await pedir("POST", `/v1/orders/${encodeURIComponent(orderId)}/cancel`, { cabecalhos: { "x-allow-cancelable-status": "at_terminal" } }));
		}
	};
}
/** Resume uma order da Point: status da order e do pagamento, e o cartão quando houver. */
function lerOrdem(d) {
	const pg = d?.transactions?.payments?.[0] ?? {};
	return {
		order_id: d?.id ? String(d.id) : null,
		payment_id: pg.id ? String(pg.id) : null,
		status_mp: d?.status ?? null,
		detalhe: pg.status_detail ?? d?.status_detail ?? null,
		bandeira: pg.payment_method?.id ?? null,
		parcelas: pg.payment_method?.installments ?? null,
		tipo_cartao: pg.payment_method?.type ?? null
	};
}
const RECUSA = {
	rejected_by_issuer: "o banco do cartão recusou",
	insufficient_amount: "saldo ou limite insuficiente",
	card_disabled: "cartão bloqueado",
	high_risk: "recusado por segurança",
	bad_filled_card_data: "dados do cartão incorretos",
	max_attempts_exceeded: "tentativas demais com este cartão",
	amount_limit_exceeded: "valor acima do limite do cartão",
	invalid_installments: "parcelamento não aceito",
	required_call_for_authorize: "o banco pede para o cliente ligar e autorizar",
	processing_error: "erro no processamento"
};
Object.assign(RECUSA, {
	bad_filled_security_code: "código de segurança incorreto",
	bad_filled_date: "validade do cartão incorreta",
	bad_filled_other: "dados do cartão incorretos",
	call_for_authorize: "o banco pede para o cliente ligar e autorizar",
	duplicated_payment: "pagamento repetido",
	blacklist: "recusado por segurança"
});
const motivoRecusa = (detalhe) => RECUSA[String(detalhe ?? "").replace(/^cc_rejected_/, "")] ?? "pagamento não aprovado";
// site/loja-publica.js
var ErroLoja = class extends Error {};
const PAGAMENTOS = {
	pix: "Pix",
	dinheiro: "Dinheiro",
	cartao: "Cartão (na entrega ou na loja)",
	boleto: "Boleto (cliente cadastrado)"
};
/** Como o cliente escolheu pagar no site. */
const MODOS = {
	pix_online: "Pix online",
	cartao_online: "Cartão online",
	entrega: "Pagar na entrega/retirada",
	whatsapp: "Combinar pelo WhatsApp"
};
const NA_ENTREGA = {
	dinheiro: "Dinheiro",
	cartao: "Cartão na maquininha",
	pix: "Pix na hora"
};
const SITUACAO_PAG = {
	aguardando: "aguardando pagamento",
	pago: "pago",
	recusado: "recusado",
	expirado: "expirou sem pagamento",
	cancelado: "cancelado",
	erro: "não foi gerado"
};
const STATUS_MP = {
	approved: "pago",
	authorized: "pago",
	rejected: "recusado",
	cancelled: "cancelado",
	refunded: "cancelado",
	charged_back: "cancelado",
	in_process: "aguardando",
	pending: "aguardando"
};
/** Texto curto do pagamento de um pedido, ex.: "Pix online · pago" ou "Na entrega: Dinheiro (troco para R$ 100,00)". */
function descreverPagamento(p) {
	const modo = p.pagamento_modo ?? "whatsapp";
	if (modo === "entrega") {
		const f = NA_ENTREGA[p.pagamento] ?? "a combinar";
		return `${p.entrega === "entrega" ? "Na entrega" : "Na retirada"}: ${f}${p.pagamento === "dinheiro" && Number(p.troco_para) > 0 ? ` (troco para ${moeda(p.troco_para)})` : ""}`;
	}
	if (modo === "whatsapp") return p.pagamento ? `Combinar pelo WhatsApp (${PAGAMENTOS[p.pagamento] ?? p.pagamento})` : "Combinar pelo WhatsApp";
	const extra = p.pagamento_status === "pago" && modo === "cartao_online" ? ` · ${p.pago_forma === "cartao_debito" ? "débito" : `crédito ${Number(p.pago_parcelas) > 1 ? `${p.pago_parcelas}x` : "à vista"}`}` : "";
	return `${MODOS[modo]} · ${SITUACAO_PAG[p.pagamento_status] ?? "aguardando pagamento"}${extra}`;
}
const cpfValido = (c) => {
	const d = String(c ?? "").replace(/\D/g, "");
	if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
	const dv = (n) => {
		const r = d.slice(0, n).split("").reduce((a, x, i) => a + Number(x) * (n + 1 - i), 0) * 10 % 11;
		return r === 10 ? 0 : r;
	};
	return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
};
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e ?? ""));
const txt = (v) => v === null || v === void 0 ? null : String(v).trim() || null;
const digitos = (v) => String(v ?? "").replace(/\D/g, "");
const exigir = (cond, msg) => {
	if (!cond) throw new ErroLoja(msg);
};
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const moeda = (n) => Number(n).toLocaleString("pt-BR", {
	style: "currency",
	currency: "BRL"
}).replace(/ /g, " ");
const qtdTexto = (q) => Number(q).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
function linkWhatsapp(numero, texto) {
	let d = digitos(numero);
	if (d && !(d.startsWith("55") && d.length >= 12)) d = "55" + d;
	return `https://wa.me/${d && d.length >= 12 ? d : ""}?text=${encodeURIComponent(texto)}`;
}
/** Texto do pedido para o WhatsApp. */
function mensagemPedido(p, itens, cfg) {
	const partes = [`Olá! Fiz o pedido nº ${p.numero} pelo site:`, ""];
	for (const i of itens) partes.push(`• ${qtdTexto(i.quantidade)} ${i.unidade} — ${i.nome} (cód. ${i.codigo}) = ${moeda(i.total)}`);
	partes.push("", `*Total: ${moeda(p.subtotal)}*`);
	partes.push(p.entrega === "entrega" ? `Entregar em: ${p.endereco}` : "Vou retirar na loja");
	partes.push(`Pagamento: ${descreverPagamento(p)}`);
	partes.push(`Nome: ${p.cliente_nome}`);
	if (p.observacao) partes.push(`Obs.: ${p.observacao}`);
	return {
		texto: partes.join("\n"),
		link: linkWhatsapp(cfg?.whatsapp, partes.join("\n"))
	};
}
/**
* db: { query(sql, params) → { rows }, transaction(fn) } · mp: cliente do Mercado Pago (real ou simulado)
* obterToken: lê o Access Token guardado · autor: quem muda a situação do pedido · urls: { notificacao, voltar }
*/
function criarLojaPublica({ db, mp, obterToken, autor = () => "site", urls = {} }) {
	const linhas = async (sql, p) => (await db.query(sql, p)).rows;
	const linha = async (sql, p) => (await linhas(sql, p))[0] ?? null;
	const config = () => linha("select * from site_config where id = 1");
	async function itensDoPedido(id) {
		return linhas(`select i.*, p.estoque_atual, p.ativo from pedido_site_itens i left join produtos p on p.id = i.produto_id
      where i.pedido_id = $1 order by i.ordem`, [id]);
	}
	async function mudarStatus(pedido, status, nota) {
		const passo = {
			status,
			em: (/* @__PURE__ */ new Date()).toISOString(),
			por: autor(),
			...nota ? { nota } : {}
		};
		return linha(`update pedidos_site set status = $2, historico = historico || $3::jsonb, atualizado_em = now()
      where id = $1 returning *`, [
			pedido.id,
			status,
			JSON.stringify([passo])
		]);
	}
	async function mercadoPagoPronto() {
		const e = await linha("select mp_conta, mp_ambiente from empresa where id = 1");
		return {
			conectado: !!await obterToken() && !!e?.mp_conta,
			conta: e?.mp_conta ?? null,
			ambiente: e?.mp_ambiente ?? null,
			simulado: !!mp.simulado
		};
	}
	/** Formas que o cliente vê no site (online só aparece com o Mercado Pago conectado). */
	async function formasDoSite(cfg) {
		const m = await mercadoPagoPronto();
		return {
			pix_online: cfg.pag_pix_online && m.conectado,
			cartao_online: cfg.pag_cartao_online && m.conectado,
			entrega: cfg.pag_entrega,
			whatsapp: cfg.pag_whatsapp || !(cfg.pag_entrega || (cfg.pag_pix_online || cfg.pag_cartao_online) && m.conectado),
			na_entrega: Object.keys(NA_ENTREGA).filter((k) => cfg[`entrega_${k}`]),
			parcelas: cfg.cartao_parcelas,
			simulado: m.simulado
		};
	}
	const PUBLICO_PAG = `id, tipo, valor::float8 as valor, status, qr_code, qr_imagem, link, expira_em, pago_em, parcelas, bandeira, forma, detalhe`;
	function respostaPagamento(pg, p) {
		if (!pg) return null;
		return {
			...pg,
			motivo: pg.status === "recusado" ? motivoRecusa(pg.detalhe) : null,
			simulado: !!mp.simulado,
			numero: Number(p.numero)
		};
	}
	/** Cria a cobrança online do pedido (Pix com QR Code ou página de cartão). Cancela um Pix anterior ainda aberto. */
	async function cobrarOnline(p, tipo) {
		const cfg = await config();
		const e = await linha("select nome_fantasia, mp_ambiente from empresa where id = 1");
		for (const ant of await linhas(`select * from pagamentos_site where pedido_id = $1 and status = 'aguardando'`, [p.id])) {
			if (ant.tipo === "pix" && ant.mp_id) await mp.cancelar(ant.mp_id).catch(() => null);
			await linhas(`update pagamentos_site set status = 'cancelado' where id = $1`, [ant.id]);
		}
		const pg0 = await linha(`insert into pagamentos_site (pedido_id, tipo, valor, ambiente) values ($1, $2, $3, $4) returning *`, [
			p.id,
			tipo,
			p.subtotal,
			e.mp_ambiente
		]);
		const referencia = `site-${p.numero}-${pg0.id.slice(0, 8)}`;
		const pg = await linha("update pagamentos_site set referencia = $2 where id = $1 returning *", [pg0.id, referencia]);
		try {
			if (tipo === "pix") {
				const r = await mp.criarPix({
					valor: Number(p.subtotal),
					descricao: `${e.nome_fantasia} - pedido ${p.numero}`.slice(0, 120),
					referencia,
					email: p.email,
					chave: pg.id,
					minutos: cfg.pix_minutos,
					notificacao: urls.notificacao ?? null
				});
				await linhas(`update pagamentos_site set mp_id = $2, status_mp = $3, detalhe = $4, qr_code = $5, qr_imagem = $6, expira_em = $7 where id = $1`, [
					pg.id,
					r.mp_id,
					r.status_mp,
					r.detalhe,
					r.qr_code,
					r.qr_imagem,
					r.expira_em
				]);
			} else {
				const itens = await linhas("select codigo, nome, unidade, quantidade, total from pedido_site_itens where pedido_id = $1 order by ordem", [p.id]);
				const r = await mp.criarPreferencia({
					itens: itens.map((i) => ({
						codigo: i.codigo,
						nome: `${qtdTexto(i.quantidade)} ${i.unidade} ${i.nome}`,
						total: Number(i.total)
					})),
					referencia,
					email: p.email,
					nome: p.cliente_nome,
					parcelas: cfg.cartao_parcelas,
					chave: pg.id,
					notificacao: urls.notificacao ?? null,
					urls: urls.voltar ? {
						success: urls.voltar,
						pending: urls.voltar,
						failure: urls.voltar
					} : null
				});
				await linhas(`update pagamentos_site set mp_id = $2, link = $3 where id = $1`, [
					pg.id,
					r.pref_id,
					r.link
				]);
			}
			await linhas(`update pedidos_site set pagamento_modo = $2, pagamento_status = 'aguardando', atualizado_em = now() where id = $1`, [p.id, tipo === "pix" ? "pix_online" : "cartao_online"]);
		} catch (er) {
			await linhas(`update pagamentos_site set status = 'erro', detalhe = $2 where id = $1`, [pg.id, String(er.message).slice(0, 300)]);
			await linhas(`update pedidos_site set pagamento_modo = $2, pagamento_status = 'erro', atualizado_em = now() where id = $1`, [p.id, tipo === "pix" ? "pix_online" : "cartao_online"]);
			throw er instanceof ErroPagamento ? new ErroLoja(tipo === "pix" ? "Não conseguimos gerar o Pix agora. Tente de novo ou escolha outra forma de pagamento." : "Não conseguimos abrir o pagamento com cartão agora. Tente de novo ou escolha outra forma de pagamento.") : er;
		}
		return respostaPagamento(await linha(`select ${PUBLICO_PAG} from pagamentos_site where id = $1`, [pg.id]), p);
	}
	/** Confere no Mercado Pago a cobrança aberta do pedido e marca o pedido como pago quando aprovar. */
	async function conferirPagamento(p) {
		const pg = await linha("select * from pagamentos_site where pedido_id = $1 order by created_at desc limit 1", [p.id]);
		if (!pg) return null;
		if (pg.status === "aguardando" || pg.tipo === "cartao" && pg.status === "recusado") {
			let r = null;
			try {
				if (pg.tipo === "pix") r = pg.mp_id ? await mp.consultar(pg.mp_id) : null;
				else r = await mp.buscarPorReferencia(pg.referencia);
			} catch {
				r = null;
			}
			if (r) {
				let st = STATUS_MP[r.status_mp] ?? "aguardando";
				if (pg.tipo === "pix" && st === "cancelado" && pg.expira_em && new Date(pg.expira_em) <= /* @__PURE__ */ new Date()) st = "expirado";
				if (pg.tipo === "pix" && st === "aguardando" && pg.expira_em && new Date(pg.expira_em) < /* @__PURE__ */ new Date(Date.now() - 6e4)) st = "expirado";
				const forma = pg.tipo === "pix" ? "pix" : r.forma ?? "cartao_credito";
				await linhas(`update pagamentos_site set status = $2, status_mp = $3, mp_pagamento = coalesce($4, mp_pagamento),
            detalhe = $5, pago_em = case when $2 = 'pago' then coalesce($6::timestamptz, now()) else pago_em end,
            parcelas = $7, bandeira = $8, forma = $9 where id = $1`, [
					pg.id,
					st,
					r.status_mp,
					r.mp_id ?? null,
					r.detalhe,
					r.aprovado_em,
					r.parcelas ?? null,
					r.bandeira ?? null,
					forma
				]);
				if (st !== "aguardando" && st !== pg.status) {
					await linhas(`update pedidos_site set pagamento_status = $2, pago_em = case when $2 = 'pago' then coalesce($3::timestamptz, now()) else pago_em end,
              pago_forma = case when $2 = 'pago' then $4 else pago_forma end, pago_parcelas = case when $2 = 'pago' then $5 else pago_parcelas end,
              pago_bandeira = case when $2 = 'pago' then $6 else pago_bandeira end, atualizado_em = now() where id = $1`, [
						p.id,
						st,
						r.aprovado_em,
						forma,
						r.parcelas ?? (pg.tipo === "pix" ? null : 1),
						r.bandeira ?? null
					]);
					const atual = await linha("select * from pedidos_site where id = $1", [p.id]);
					if (st === "pago" && atual.status === "novo") await mudarStatus(atual, "confirmado", `pago pelo site (${forma === "pix" ? "Pix" : forma === "cartao_debito" ? "cartão de débito" : "cartão de crédito"})`);
				}
			}
		}
		return respostaPagamento(await linha(`select ${PUBLICO_PAG} from pagamentos_site where id = $1`, [pg.id]), p);
	}
	/** Pedido público: confere número + telefone (o mesmo usado em Acompanhar pedido). */
	async function pedidoDoCliente(numero, telefone) {
		const n = Number(digitos(numero));
		const fone = digitos(telefone);
		exigir(n > 0 && fone.length >= 8, "Informe o número do pedido e o telefone usado nele.");
		const p = await linha("select * from pedidos_site where numero = $1", [n]);
		exigir(p && (p.telefone.endsWith(fone) || fone.endsWith(p.telefone)), "Não encontramos esse pedido. Confira o número e o telefone.");
		return p;
	}
	return {
		acoes: {
			"site.vitrine": ["publico", async () => {
				const [cfg, emp, departamentos, produtos, totais] = await Promise.all([
					config(),
					linha("select nome_fantasia, telefone, email, permitir_estoque_negativo, razao_social, cnpj, logradouro, numero, bairro, municipio, uf, cep from empresa where id = 1"),
					linhas(`select c.id, c.nome, c.icone, c.ordem, count(p.id)::int as qtd from categorias_produto c
          join produtos p on p.categoria_id = c.id and p.ativo and p.site_visivel
          group by c.id order by c.ordem, c.nome`),
					linhas(`select p.id, p.codigo, p.nome, p.marca, p.descricao, p.preco_venda::float8 as preco, p.unidade, p.categoria_id,
            c.nome as departamento, p.site_destaque as destaque, p.imagem, p.ilustracao,
            greatest(p.estoque_atual - coalesce((select sum(ri.quantidade) from pedido_site_itens ri join pedidos_site rs on rs.id = ri.pedido_id
              where ri.produto_id = p.id and rs.status not in ('entregue', 'cancelado') and rs.venda_id is null), 0), 0)::float8 as estoque, p.estoque_minimo::float8 as minimo,
            (select count(*) from produto_midias m where m.produto_id = p.id and m.tipo = 'foto')::int as qtd_fotos,
            (select count(*) from produto_midias m where m.produto_id = p.id and m.tipo <> 'foto')::int as qtd_videos
          from produtos p left join categorias_produto c on c.id = p.categoria_id
          where p.ativo and p.site_visivel order by p.site_destaque desc, p.nome`),
					linha(`select coalesce(sum(greatest(estoque_atual, 0)) filter (where unidade in ('UN','PC','SC','CX','PAR','RL','GL','BD','KIT')), 0)::float8 as unidades
          from produtos where ativo and site_visivel`)
				]);
				const vende = emp.permitir_estoque_negativo;
				return {
					loja: emp.nome_fantasia,
					config: {
						...cfg,
						pedido_minimo: Number(cfg.pedido_minimo),
						telefone: emp.telefone,
						email: cfg.email || emp.email,
						pagamentos: await formasDoSite(cfg),
						empresa: {
							razao_social: emp.razao_social,
							cnpj: emp.cnpj,
							endereco: [
								emp.logradouro && `${emp.logradouro}${emp.numero ? `, ${emp.numero}` : ""}`,
								emp.bairro,
								emp.municipio && `${emp.municipio}${emp.uf ? `/${emp.uf}` : ""}`,
								emp.cep && `CEP ${emp.cep}`
							].filter(Boolean).join(" — ")
						}
					},
					departamentos,
					produtos: produtos.map((p) => ({
						...p,
						situacao: !vende && p.estoque <= 0 ? "esgotado" : p.estoque <= Math.max(p.minimo, 5) && !vende ? "pouco" : "ok",
						limite: vende ? 9999 : p.estoque
					})),
					numeros: {
						produtos: produtos.length,
						departamentos: departamentos.length,
						unidades: Math.round(totais.unidades)
					}
				};
			}],
			"site.pedir": ["publico", async (d) => {
				const cfg = await config();
				const emp = await linha("select permitir_estoque_negativo from empresa where id = 1");
				const nome = txt(d.cliente_nome);
				const fone = digitos(d.telefone);
				exigir(nome && nome.length >= 2, "Diga seu nome para a loja saber de quem é o pedido.");
				exigir(fone.length >= 10 && fone.length <= 13, "Informe um telefone com DDD, ex.: (82) 99999-9999.");
				exigir(["retirada", "entrega"].includes(d.entrega), "Escolha entre retirar na loja ou receber em casa.");
				const formas = await formasDoSite(cfg);
				const modo = d.pagamento_modo ?? "whatsapp";
				exigir(MODOS[modo], "Forma de pagamento inválida.");
				exigir(formas[modo] || modo === "whatsapp" && !d.pagamento_modo, "Esta forma de pagamento não está disponível no momento. Escolha outra.");
				const email = txt(d.email)?.toLowerCase() ?? null;
				exigir(!email || emailValido(email), "Confira o e-mail: parece que falta alguma coisa.");
				if (modo === "pix_online" || modo === "cartao_online") exigir(email, "Informe seu e-mail: o Mercado Pago pede para o pagamento online.");
				const cpf = digitos(d.cpf) || null;
				exigir(!cpf || cpfValido(cpf), "CPF inválido. Confira os números ou deixe em branco.");
				let endereco = null;
				const end = {
					cep: digitos(d.cep) || null,
					rua: txt(d.rua),
					numero_casa: txt(d.numero_casa),
					complemento: txt(d.complemento),
					bairro: txt(d.bairro),
					cidade: txt(d.cidade),
					referencia: txt(d.referencia)
				};
				if (d.entrega === "entrega") {
					exigir(cfg.aceita_entrega, "No momento a loja não está fazendo entregas. Escolha retirar na loja.");
					if (end.rua || end.bairro || end.numero_casa) {
						exigir(end.rua && end.rua.length >= 3, "Informe a rua da entrega.");
						exigir(end.numero_casa, "Informe o número (ou \"s/n\").");
						exigir(end.bairro, "Informe o bairro da entrega.");
						exigir(!end.cep || end.cep.length === 8, "O CEP tem 8 números.");
						endereco = [
							`${end.rua}, ${end.numero_casa}${end.complemento ? ` (${end.complemento})` : ""}`,
							end.bairro,
							end.cidade || cfg.cidade,
							end.cep ? `CEP ${end.cep.slice(0, 5)}-${end.cep.slice(5)}` : null
						].filter(Boolean).join(" — ") + (end.referencia ? ` · Ref.: ${end.referencia}` : "");
					} else {
						exigir(txt(d.endereco) && txt(d.endereco).length >= 8, "Informe o endereço de entrega com rua, número e bairro.");
						endereco = txt(d.endereco);
					}
				}
				if (modo === "entrega") exigir(formas.na_entrega.includes(d.pagamento), `Escolha como vai pagar na ${d.entrega === "entrega" ? "entrega" : "retirada"}.`);
				else exigir(!d.pagamento || PAGAMENTOS[d.pagamento], "Forma de pagamento inválida.");
				const troco = modo === "entrega" && d.pagamento === "dinheiro" ? Math.max(0, Number(String(d.troco_para ?? "").replace(/\./g, "").replace(",", ".")) || 0) : 0;
				exigir(Array.isArray(d.itens) && d.itens.length, "O carrinho está vazio.");
				exigir(d.itens.length <= 80, "Pedido grande demais para o site. Fale com a loja pelo WhatsApp.");
				const ids = d.itens.map((i) => i.produto_id);
				const prods = new Map((await linhas(`select p.*, p.estoque_atual - coalesce((select sum(ri.quantidade) from pedido_site_itens ri join pedidos_site rs on rs.id = ri.pedido_id
              where ri.produto_id = p.id and rs.status not in ('entregue', 'cancelado') and rs.venda_id is null), 0) as disponivel from produtos p where p.id = any($1::uuid[]) and p.ativo and p.site_visivel`, [ids])).map((p) => [p.id, p]));
				const itens = [];
				for (const i of d.itens) {
					const p = prods.get(i.produto_id);
					exigir(p, "Um dos produtos do carrinho não está mais à venda. Atualize a página.");
					const q = Math.round(Number(i.quantidade) * 1e3) / 1e3;
					exigir(q > 0 && q <= 99999, `Quantidade inválida para ${p.nome}.`);
					if (!emp.permitir_estoque_negativo) {
						const tem = Math.max(0, Number(p.disponivel));
						exigir(tem > 0, `${p.nome} acabou de esgotar. Tire-o do carrinho para continuar.`);
						exigir(q <= tem, `Temos só ${qtdTexto(tem)} ${p.unidade} de ${p.nome}. Ajuste a quantidade.`);
					}
					itens.push({
						p,
						q,
						preco: Number(p.preco_venda),
						total: r2(q * Number(p.preco_venda))
					});
				}
				const subtotal = r2(itens.reduce((s, i) => s + i.total, 0));
				exigir(subtotal >= Number(cfg.pedido_minimo), `O pedido mínimo pelo site é ${moeda(cfg.pedido_minimo)}.`);
				exigir(!troco || troco >= subtotal, `O troco precisa ser para um valor acima de ${moeda(subtotal)}.`);
				const pedido = await db.transaction(async (t) => {
					const ent = d.entrega === "entrega";
					const ped = (await t.query(`insert into pedidos_site (cliente_nome, telefone, entrega, endereco, pagamento, observacao, subtotal, historico,
            email, cpf, cep, rua, numero_casa, complemento, bairro, cidade, referencia, pagamento_modo, troco_para)
          values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning *`, [
						nome,
						fone,
						d.entrega,
						endereco,
						modo === "entrega" || modo === "whatsapp" ? d.pagamento || null : null,
						txt(d.observacao)?.slice(0, 500) ?? null,
						subtotal,
						JSON.stringify([{
							status: "novo",
							em: (/* @__PURE__ */ new Date()).toISOString(),
							por: "site"
						}]),
						email,
						cpf,
						ent ? end.cep : null,
						ent ? end.rua : null,
						ent ? end.numero_casa : null,
						ent ? end.complemento : null,
						ent ? end.bairro : null,
						ent ? end.cidade || (end.rua ? cfg.cidade : null) : null,
						ent ? end.referencia : null,
						modo,
						troco || null
					])).rows[0];
					for (const i of itens) await t.query(`insert into pedido_site_itens (pedido_id, produto_id, codigo, nome, unidade, quantidade, preco, total)
            values ($1, $2, $3, $4, $5, $6, $7, $8)`, [
						ped.id,
						i.p.id,
						i.p.codigo,
						i.p.nome,
						i.p.unidade,
						i.q,
						i.preco,
						i.total
					]);
					return ped;
				});
				let pagamento = null;
				let erroPagamento = null;
				if (modo === "pix_online" || modo === "cartao_online") try {
					pagamento = await cobrarOnline(pedido, modo === "pix_online" ? "pix" : "cartao");
				} catch (er) {
					erroPagamento = er.message;
				}
				const atual = await linha("select * from pedidos_site where id = $1", [pedido.id]);
				const msg = mensagemPedido(atual, await itensDoPedido(pedido.id), cfg);
				return {
					numero: Number(pedido.numero),
					subtotal,
					whatsapp: msg.link,
					mensagem: msg.texto,
					temNumero: !!digitos(cfg.whatsapp),
					modo,
					pagamento,
					erroPagamento,
					descricao: descreverPagamento(atual)
				};
			}],
			/** O site pergunta a cada poucos segundos: o Pix/cartão já foi pago? */
			"site.pagamento": ["publico", async ({ numero, telefone }) => {
				const p = await pedidoDoCliente(numero, telefone);
				const pg = await conferirPagamento(p);
				const atual = await linha("select * from pedidos_site where id = $1", [p.id]);
				return {
					pagamento: pg,
					status: atual.status,
					pagamento_status: atual.pagamento_status,
					descricao: descreverPagamento(atual)
				};
			}],
			/** Pagar de novo (Pix expirou, cartão recusado) ou trocar a forma de pagamento de um pedido ainda não pago. */
			"site.pagar": ["publico", async ({ numero, telefone, modo, pagamento, troco_para }) => {
				const p = await pedidoDoCliente(numero, telefone);
				exigir(!["entregue", "cancelado"].includes(p.status), "Este pedido já foi encerrado.");
				exigir(p.pagamento_status !== "pago", "Este pedido já está pago.");
				exigir(!p.venda_id, "A loja já registrou este pedido. Fale com a loja pelo WhatsApp.");
				const cfg = await config();
				const formas = await formasDoSite(cfg);
				exigir(MODOS[modo] && formas[modo], "Esta forma de pagamento não está disponível no momento.");
				if (modo === "pix_online" || modo === "cartao_online") {
					exigir(p.email, "Este pedido não tem e-mail. Fale com a loja pelo WhatsApp.");
					return {
						pagamento: await cobrarOnline(p, modo === "pix_online" ? "pix" : "cartao"),
						descricao: descreverPagamento(await linha("select * from pedidos_site where id = $1", [p.id]))
					};
				}
				if (modo === "entrega") exigir(formas.na_entrega.includes(pagamento), "Escolha como vai pagar.");
				for (const ant of await linhas(`select * from pagamentos_site where pedido_id = $1 and status = 'aguardando'`, [p.id])) {
					if (ant.tipo === "pix" && ant.mp_id) await mp.cancelar(ant.mp_id).catch(() => null);
					await linhas(`update pagamentos_site set status = 'cancelado' where id = $1`, [ant.id]);
				}
				const troco = modo === "entrega" && pagamento === "dinheiro" ? Math.max(0, Number(String(troco_para ?? "").replace(/\./g, "").replace(",", ".")) || 0) : 0;
				const atual = await linha(`update pedidos_site set pagamento_modo = $2, pagamento = $3, troco_para = $4, pagamento_status = null, atualizado_em = now()
        where id = $1 returning *`, [
					p.id,
					modo,
					modo === "entrega" ? pagamento : null,
					troco || null
				]);
				const msg = mensagemPedido(atual, await itensDoPedido(p.id), cfg);
				return {
					pagamento: null,
					descricao: descreverPagamento(atual),
					whatsapp: msg.link
				};
			}],
			/** Prévia: aprova (ou recusa) a cobrança simulada. */
			"site.simularPagamento": ["publico", async ({ numero, telefone, resultado = "aprovado", parcelas = 1, tipo = "credito" }) => {
				exigir(mp.simulado, "Disponível só na prévia.");
				const p = await pedidoDoCliente(numero, telefone);
				const pg = await linha(`select * from pagamentos_site where pedido_id = $1 and (status = 'aguardando' or (tipo = 'cartao' and status = 'recusado'))
        order by created_at desc limit 1`, [p.id]);
				exigir(pg, "Nenhum pagamento aberto neste pedido.");
				if (pg.tipo === "pix") await mp.aprovar(pg.mp_id);
				else await mp.simularCartao(pg.referencia, resultado, Number(parcelas) || 1, tipo);
				return conferirPagamento(p);
			}],
			"site.acompanhar": ["publico", async ({ numero, telefone }) => {
				const n = Number(digitos(numero));
				const fone = digitos(telefone);
				exigir(n > 0 && fone.length >= 8, "Informe o número do pedido e o telefone usado nele.");
				const p = await linha("select * from pedidos_site where numero = $1", [n]);
				exigir(p && (p.telefone.endsWith(fone) || fone.endsWith(p.telefone)), "Não encontramos esse pedido. Confira o número e o telefone.");
				const itens = await linhas("select nome, unidade, quantidade::float8, preco::float8, total::float8 from pedido_site_itens where pedido_id = $1 order by ordem", [p.id]);
				return {
					numero: Number(p.numero),
					status: p.status,
					entrega: p.entrega,
					subtotal: Number(p.subtotal),
					criado: p.created_at,
					historico: p.historico.map((h) => ({
						status: h.status,
						em: h.em
					})),
					itens,
					pagamento: {
						modo: p.pagamento_modo ?? "whatsapp",
						status: p.pagamento_status,
						descricao: descreverPagamento(p),
						podePagar: ["pix_online", "cartao_online"].includes(p.pagamento_modo) && p.pagamento_status !== "pago" && !p.venda_id && !["entregue", "cancelado"].includes(p.status)
					}
				};
			}],
			"site.midias": ["publico", async ({ produto_id }) => {
				const p = await linha("select 1 from produtos where id = $1 and ativo and site_visivel", [produto_id]);
				exigir(p, "Produto não encontrado.");
				return linhas(`select id, tipo, case when tipo = 'video' and arquivo is not null then null else conteudo end as conteudo, mime, nome, tamanho
        from produto_midias where produto_id = $1 order by ordem, created_at`, [produto_id]);
			}],
			"site.video": ["publico", async ({ id }) => {
				const v = await linha(`select m.arquivo, m.mime from produto_midias m join produtos p on p.id = m.produto_id
        where m.id = $1 and m.tipo = 'video' and p.ativo and p.site_visivel`, [id]);
				exigir(v, "Vídeo não encontrado.");
				return {
					mime: v.mime,
					arquivo: v.arquivo
				};
			}]
		},
		config,
		itensDoPedido,
		mudarStatus,
		mercadoPagoPronto,
		formasDoSite,
		cobrarOnline,
		conferirPagamento,
		pedidoDoCliente,
		mensagemPedido
	};
}
// nuvem/loja.js
const PUBLICAS = [
	"site.vitrine",
	"site.pedir",
	"site.acompanhar",
	"site.pagamento",
	"site.pagar",
	"site.midias"
];
const COLS_EMPRESA = [
	"nome_fantasia",
	"razao_social",
	"cnpj",
	"telefone",
	"email",
	"logradouro",
	"numero",
	"bairro",
	"municipio",
	"uf",
	"cep",
	"permitir_estoque_negativo"
];
const COLS_SITE = [
	"whatsapp",
	"instagram",
	"email",
	"endereco",
	"cidade",
	"horario",
	"aviso_topo",
	"titulo_destaque",
	"texto_destaque",
	"entrega_texto",
	"aceita_entrega",
	"pedido_minimo",
	"pag_pix_online",
	"pag_cartao_online",
	"pag_entrega",
	"pag_whatsapp",
	"entrega_dinheiro",
	"entrega_cartao",
	"entrega_pix",
	"cartao_parcelas",
	"pix_minutos"
];
const COLS_PRODUTO = [
	"codigo",
	"nome",
	"marca",
	"descricao",
	"preco_venda",
	"unidade",
	"categoria_id",
	"site_destaque",
	"site_visivel",
	"ativo",
	"ilustracao",
	"estoque_atual",
	"estoque_minimo"
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"video/ogg": "ogv"
};
async function sha256(texto) {
	const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(texto)));
	return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
/**
* db: { query, transaction } · mp: cliente do Mercado Pago · armazenamento: { assinarEnvio(caminho, mime), apagar(caminhos) }
* urls: { notificacao, voltar } — avisos do Mercado Pago e volta do cliente depois do cartão.
*/
/** conferirSenha(senha, hash) → boolean: confere a senha do caixa (scrypt), vinda de quem chama (Node/Deno). */
function criarLojaNuvem({ db, mp, armazenamento, urls = {}, conferirSenha = async () => false }) {
	const linhas = async (sql, p) => (await db.query(sql, p)).rows;
	const linha = async (sql, p) => (await linhas(sql, p))[0] ?? null;
	let autor = "site";
	const loja = criarLojaPublica({
		db,
		mp,
		urls,
		autor: () => autor,
		obterToken: async () => (await linha(`select valor from segredos where nome = 'mp_token'`))?.valor ?? null
	});
	const exigir = (c, m) => {
		if (!c) throw new ErroLoja(m);
	};
	async function chaveValida(chave) {
		if (!chave || String(chave).length < 20) return false;
		const h = await linha(`select valor from segredos where nome = 'chave_caixa'`);
		return !!h && h.valor === await sha256(chave);
	}
	async function limitar(chave, max, minutos) {
		await linhas(`delete from limites where em < now() - interval '1 day'`);
		const n = Number((await linha(`select count(*)::int as n from limites where chave = $1 and em > now() - ($2::int * interval '1 minute')`, [chave, minutos])).n);
		exigir(n < max, "Muitos pedidos seguidos deste aparelho. Espere alguns minutos ou fale com a loja pelo WhatsApp.");
		await linhas("insert into limites (chave) values ($1)", [chave]);
	}
	const pedidoCompleto = async (p) => ({
		...p,
		itens: await linhas("select produto_id, codigo, nome, unidade, quantidade::float8 as quantidade, preco::float8 as preco, total::float8 as total from pedido_site_itens where pedido_id = $1 order by ordem", [p.id]),
		pagamentos: await linhas(`select id, tipo, valor::float8 as valor, status, created_at, pago_em, parcelas, bandeira, forma, ambiente, mp_id, referencia
      from pagamentos_site where pedido_id = $1 order by created_at`, [p.id])
	});
	async function aplicarStatus(p, status, por, nota) {
		exigir([
			"novo",
			"confirmado",
			"separando",
			"pronto",
			"entregue",
			"cancelado"
		].includes(status), "Situação inválida.");
		autor = por;
		try {
			if (status === "cancelado") {
				for (const ant of await linhas(`select * from pagamentos_site where pedido_id = $1 and status = 'aguardando'`, [p.id])) {
					if (ant.tipo === "pix" && ant.mp_id) await mp.cancelar(ant.mp_id).catch(() => null);
					await linhas(`update pagamentos_site set status = 'cancelado' where id = $1`, [ant.id]);
				}
				if (p.pagamento_status === "aguardando") await linhas(`update pedidos_site set pagamento_status = 'cancelado' where id = $1`, [p.id]);
			}
			await loja.mudarStatus(p, status, txt(nota) ?? (status === "cancelado" && p.pagamento_status === "pago" ? "já estava pago online: devolva o valor pelo Mercado Pago" : void 0));
		} finally {
			autor = "site";
		}
	}
	const SEGUINTE = {
		novo: "confirmado",
		confirmado: "separando",
		separando: "pronto",
		pronto: "entregue"
	};
	const SESSAO_DIAS = 30;
	function tokenNovo() {
		const b = /* @__PURE__ */ new Uint8Array(32);
		crypto.getRandomValues(b);
		return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}
	async function sessaoDe(token) {
		if (!token || String(token).length < 30) return null;
		const s = await linha(`select s.login, u.nome, u.papel from sessoes_web s join usuarios_web u on u.login = s.login and u.ativo
      where s.token_hash = $1 and s.expira > now()`, [await sha256(token)]);
		if (s) await linhas(`update sessoes_web set ultimo_uso = now(), expira = now() + ($2::int * interval '1 day') where token_hash = $1`, [await sha256(token), SESSAO_DIAS]);
		return s;
	}
	const listaPedidos = `select p.id, p.numero::int as numero, p.created_at, p.cliente_nome, p.telefone, p.entrega, p.status, p.subtotal::float8 as subtotal,
      p.pagamento_modo, p.pagamento_status, p.pagamento, p.troco_para, p.pago_forma, p.pago_parcelas, p.venda_numero,
      (select count(*)::int from pedido_site_itens i where i.pedido_id = p.id) as qtd_itens from pedidos_site p`;
	const admin = {
		"admin.eu": async (_d, s) => ({
			nome: s.nome,
			papel: s.papel,
			loja: (await linha("select nome_fantasia from empresa where id = 1")).nome_fantasia
		}),
		"admin.sair": async (_d, _s, token) => {
			await linhas("delete from sessoes_web where token_hash = $1", [await sha256(token)]);
			return true;
		},
		"admin.resumo": async () => linha(`select count(*) filter (where status = 'novo')::int as novos,
        count(*) filter (where status not in ('entregue', 'cancelado'))::int as abertos,
        coalesce(sum(subtotal) filter (where pagamento_status = 'pago' and pago_em >= date_trunc('day', now() at time zone 'America/Maceio') at time zone 'America/Maceio'), 0)::float8 as pago_hoje,
        count(*) filter (where created_at >= date_trunc('day', now() at time zone 'America/Maceio') at time zone 'America/Maceio')::int as hoje
      from pedidos_site`),
		"admin.pedidos": async ({ status = "abertos", busca } = {}) => {
			const termo = txt(busca) ? `%${txt(busca).toLowerCase()}%` : null;
			return (await linhas(`${listaPedidos}
        where case $1 when 'abertos' then p.status not in ('entregue', 'cancelado') when 'todos' then true else p.status = $1 end
          and ($2::text is null or lower(p.cliente_nome) like $2 or p.telefone like $2 or p.numero::text like $2)
        order by case when p.status = 'novo' then 0 else 1 end, p.created_at desc limit 300`, [status, termo])).map((p) => ({
				...p,
				pagamento_descricao: descreverPagamento(p)
			}));
		},
		"admin.pedido": async ({ id }) => {
			const p0 = await linha("select * from pedidos_site where id = $1", [id]);
			exigir(p0, "Pedido não encontrado.");
			if (p0.pagamento_status === "aguardando") await loja.conferirPagamento(p0).catch(() => null);
			const p = await linha("select *, numero::int as numero, subtotal::float8 as subtotal from pedidos_site where id = $1", [id]);
			const c = await pedidoCompleto(p);
			const loja_ = (await linha("select nome_fantasia from empresa where id = 1")).nome_fantasia;
			return {
				...c,
				pagamento_descricao: descreverPagamento(p),
				proximo: SEGUINTE[p.status] ?? null,
				whatsapp: linkWhatsapp(p.telefone, `Olá, ${String(p.cliente_nome).split(" ")[0]}! Aqui é da ${loja_}, sobre o seu pedido nº ${p.numero}: `)
			};
		},
		"admin.status": async ({ id, status }, s) => {
			const p = await linha("select * from pedidos_site where id = $1", [id]);
			exigir(p, "Pedido não encontrado.");
			exigir(!["entregue", "cancelado"].includes(p.status), "Este pedido já foi encerrado.");
			if (status === "cancelado") exigir(!p.venda_id, `Este pedido já virou a venda nº ${p.venda_numero ?? ""} no caixa. Cancele a venda no caixa.`);
			else exigir(status === SEGUINTE[p.status], "Atualize a página: o pedido mudou.");
			await aplicarStatus(p, status, s.nome, null);
			return admin["admin.pedido"]({ id });
		}
	};
	const caixa = {
		"caixa.estado": async () => {
			const e = await linha("select nome_fantasia, mp_conta, mp_ambiente from empresa where id = 1");
			const v = await linha("select coalesce(max(versao), 0)::text as versao, count(*) filter (where status = 'novo')::int as novos from pedidos_site");
			const p = await linha("select count(*)::int as n from produtos where ativo");
			return {
				loja: e.nome_fantasia,
				mp_conectado: !!await linha(`select 1 from segredos where nome = 'mp_token'`),
				mp_conta: e.mp_conta,
				versao: v.versao,
				pedidos_novos: v.novos,
				produtos: p.n
			};
		},
		/** Recebe do caixa: dados da empresa, textos/pagamentos do site, departamentos e produtos (só os que mudaram). */
		"caixa.publicar": async ({ empresa, site, categorias, produtos, produtos_ids, usuarios }) => {
			await db.transaction(async (t) => {
				const q = (s, p) => t.query(s, p);
				if (Array.isArray(usuarios)) {
					for (const u of usuarios) {
						if (!txt(u.login) || !/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(u.senha_hash ?? "")) continue;
						const login = txt(u.login).toLowerCase();
						const antes = (await q("select senha_hash, ativo from usuarios_web where login = $1", [login])).rows[0];
						if (antes && (antes.senha_hash !== u.senha_hash || antes.ativo && !u.ativo)) await q("delete from sessoes_web where login = $1", [login]);
						await q(`insert into usuarios_web (login, nome, papel, senha_hash, ativo) values ($1, $2, $3, $4, $5)
              on conflict (login) do update set nome = excluded.nome, papel = excluded.papel, senha_hash = excluded.senha_hash, ativo = excluded.ativo, atualizado_em = now()`, [
							login,
							txt(u.nome) ?? login,
							u.papel === "dono" ? "dono" : "funcionario",
							u.senha_hash,
							u.ativo !== false
						]);
					}
					const logins = usuarios.map((u) => txt(u.login)?.toLowerCase()).filter(Boolean);
					await q("delete from sessoes_web where not (login = any($1::text[]))", [logins]);
					await q("update usuarios_web set ativo = false where not (login = any($1::text[]))", [logins]);
				}
				if (empresa) {
					const cols = COLS_EMPRESA.filter((c) => c in empresa);
					if (cols.length) await q(`update empresa set ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}, atualizado_em = now() where id = 1`, cols.map((c) => empresa[c]));
				}
				if (site) {
					const cols = COLS_SITE.filter((c) => c in site);
					if (cols.length) await q(`update site_config set ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}, updated_at = now() where id = 1`, cols.map((c) => site[c]));
				}
				if (Array.isArray(categorias)) {
					for (const c of categorias) {
						if (!UUID.test(c.id)) continue;
						await q(`insert into categorias_produto (id, nome, icone, ordem) values ($1, $2, $3, $4)
              on conflict (id) do update set nome = excluded.nome, icone = excluded.icone, ordem = excluded.ordem`, [
							c.id,
							c.nome,
							c.icone ?? null,
							Number(c.ordem ?? 0)
						]);
					}
					await q("delete from categorias_produto where not (id = any($1::uuid[]))", [categorias.map((c) => c.id).filter((x) => UUID.test(x))]);
				}
				const PADRAO = {
					preco_venda: 0,
					estoque_atual: 0,
					estoque_minimo: 0,
					unidade: "UN",
					site_destaque: false,
					site_visivel: true,
					ativo: true
				};
				const colunas = COLS_PRODUTO.join(", ");
				const marcas = COLS_PRODUTO.map((_, i) => "$" + (i + 2)).join(", ");
				const trocas = COLS_PRODUTO.map((c) => c + " = excluded." + c).join(", ");
				for (const p of produtos ?? []) {
					if (!UUID.test(p.id) || !txt(p.nome)) continue;
					const vals = COLS_PRODUTO.map((c) => p[c] ?? PADRAO[c] ?? null);
					await q("insert into produtos (id, " + colunas + ") values ($1, " + marcas + ") on conflict (id) do update set " + trocas + ", updated_at = now()", [p.id, ...vals]);
				}
				if (Array.isArray(produtos_ids)) await q("update produtos set ativo = false where ativo and not (id = any($1::uuid[]))", [produtos_ids.filter((x) => UUID.test(x))]);
			});
			return caixa["caixa.estado"]();
		},
		/** Endereço para o caixa enviar a foto/vídeo direto para o armazenamento (sem passar pelo servidor). */
		"caixa.midiaEnvio": async ({ produto_id, midia_id, mime }) => {
			exigir(UUID.test(produto_id) && UUID.test(midia_id), "Mídia inválida.");
			exigir(EXT[mime], "Formato não aceito.");
			const caminho = `produtos/${produto_id}/${midia_id}.${EXT[mime]}`;
			return armazenamento.assinarEnvio(caminho, mime);
		},
		/** Galeria do produto na ordem certa; a primeira foto vira a capa. */
		"caixa.midias": async ({ produto_id, itens = [] }) => {
			exigir(await linha("select 1 from produtos where id = $1", [produto_id]), "Produto ainda não publicado.");
			const antigos = await linhas(`select conteudo from produto_midias where produto_id = $1 and tipo <> 'link'`, [produto_id]);
			await db.transaction(async (t) => {
				await t.query("delete from produto_midias where produto_id = $1", [produto_id]);
				for (const [ordem, m] of itens.entries()) {
					if (!UUID.test(m.id) || ![
						"foto",
						"video",
						"link"
					].includes(m.tipo) || !/^https:\/\/\S+$/.test(m.conteudo ?? "")) continue;
					await t.query(`insert into produto_midias (id, produto_id, tipo, ordem, conteudo, mime, nome, tamanho) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [
						m.id,
						produto_id,
						m.tipo,
						ordem,
						m.conteudo,
						m.mime ?? null,
						txt(m.nome)?.slice(0, 120) ?? null,
						m.tamanho ?? null
					]);
				}
				await t.query(`update produtos set imagem = (select conteudo from produto_midias where produto_id = $1 and tipo = 'foto' order by ordem limit 1), updated_at = now() where id = $1`, [produto_id]);
			});
			const ficaram = new Set(itens.map((m) => m.conteudo));
			const apagar = antigos.map((a) => a.conteudo).filter((u) => u && !ficaram.has(u));
			if (apagar.length) await armazenamento.apagar?.(apagar).catch(() => {});
			return true;
		},
		/** Pedidos criados ou alterados depois da última versão que o caixa já tem. */
		"caixa.pedidos": async ({ desde = "0", limite = 50 } = {}) => {
			const lista = await linhas(`select *, versao::text as versao, numero::int as numero from pedidos_site where pedidos_site.versao > $1::bigint order by pedidos_site.versao limit $2`, [String(desde || "0"), Math.min(200, Math.max(1, Number(limite) || 50))]);
			const pedidos = [];
			for (const p of lista) pedidos.push(await pedidoCompleto(p));
			return {
				pedidos,
				ate: lista.length ? lista.at(-1).versao : String(desde || "0"),
				mais: lista.length >= (Number(limite) || 50)
			};
		},
		/** O caixa mudou a situação do pedido, registrou a venda ou cancelou. */
		"caixa.pedido": async ({ id, status, nota, venda_id, venda_numero, por }) => {
			const p = await linha("select * from pedidos_site where id = $1", [id]);
			exigir(p, "Pedido não encontrado no site.");
			if (venda_id !== void 0) await linhas("update pedidos_site set venda_id = $2, venda_numero = $3 where id = $1", [
				id,
				venda_id || null,
				venda_numero ?? null
			]);
			if (status && status !== p.status) await aplicarStatus(p, status, txt(por) ?? "loja", nota);
			return pedidoCompleto(await linha("select *, versao::text as versao, numero::int as numero from pedidos_site where id = $1", [id]));
		},
		/** Confere no Mercado Pago agora (o dono abriu o pedido no caixa). */
		"caixa.conferir": async ({ id }) => {
			const p = await linha("select * from pedidos_site where id = $1", [id]);
			exigir(p, "Pedido não encontrado no site.");
			await loja.conferirPagamento(p);
			return pedidoCompleto(await linha("select *, versao::text as versao, numero::int as numero from pedidos_site where id = $1", [id]));
		},
		/** Access Token do Mercado Pago da loja (só o servidor usa; nunca vai para o site). */
		"caixa.segredo": async ({ nome, valor, conta, ambiente }) => {
			exigir(nome === "mp_token", "Segredo inválido.");
			if (valor) {
				exigir(/^(APP_USR|TEST)-[\w-]{20,}$/.test(String(valor)), "Access Token inválido.");
				await linhas(`insert into segredos (nome, valor) values ('mp_token', $1) on conflict (nome) do update set valor = excluded.valor, atualizado_em = now()`, [valor]);
				await linhas("update empresa set mp_conta = $1, mp_ambiente = $2 where id = 1", [txt(conta), txt(ambiente)]);
			} else {
				await linhas(`delete from segredos where nome = 'mp_token'`);
				await linhas("update empresa set mp_conta = null, mp_ambiente = null where id = 1");
			}
			return caixa["caixa.estado"]();
		}
	};
	/** Aviso automático do Mercado Pago: confere o pagamento citado e atualiza o pedido. */
	async function avisoMercadoPago({ tipo, id }) {
		if (!id || tipo && !/payment/.test(tipo)) return { ignorado: true };
		let r;
		try {
			r = await mp.buscarPagamento(String(id));
		} catch {
			return { ignorado: true };
		}
		const pg = r.referencia && await linha("select pedido_id from pagamentos_site where referencia = $1 order by created_at desc limit 1", [r.referencia]) || await linha("select pedido_id from pagamentos_site where mp_id = $1 limit 1", [String(id)]);
		if (!pg) return { ignorado: true };
		const p = await linha("select * from pedidos_site where id = $1", [pg.pedido_id]);
		await loja.conferirPagamento(p);
		return { ok: true };
	}
	/** contexto: { chave, ip } */
	async function tratar(acao, dados = {}, contexto = {}) {
		try {
			if (PUBLICAS.includes(acao)) {
				if (acao === "site.pedir") await limitar(`pedido:${contexto.ip ?? "?"}`, 12, 15);
				if (acao === "site.pagar" || acao === "site.acompanhar") await limitar(`${acao}:${contexto.ip ?? "?"}`, 60, 10);
				return {
					ok: true,
					dados: await loja.acoes[acao][1](dados ?? {})
				};
			}
			if (caixa[acao]) {
				if (!await chaveValida(contexto.chave)) return {
					ok: false,
					erro: "Chave da loja inválida. Confira o código de conexão em Configurações › Site.",
					semChave: true
				};
				return {
					ok: true,
					dados: await caixa[acao](dados ?? {})
				};
			}
			if (acao === "admin.entrar") {
				await limitar(`entrar:${contexto.ip ?? "?"}`, 10, 15);
				const login = txt(dados?.login)?.toLowerCase();
				const u = login && await linha("select login, nome, papel, senha_hash from usuarios_web where login = $1 and ativo", [login]);
				const ok = u && await conferirSenha(String(dados?.senha ?? ""), u.senha_hash).catch(() => false);
				exigir(ok, "Usuário ou senha incorretos. Use o mesmo usuário e senha do caixa.");
				const token = tokenNovo();
				await linhas(`delete from sessoes_web where expira < now()`);
				await linhas(`insert into sessoes_web (token_hash, login, expira) values ($1, $2, now() + ($3::int * interval '1 day'))`, [
					await sha256(token),
					u.login,
					SESSAO_DIAS
				]);
				return {
					ok: true,
					dados: {
						token,
						nome: u.nome,
						papel: u.papel
					}
				};
			}
			if (admin[acao]) {
				const s = await sessaoDe(contexto.sessao);
				if (!s) return {
					ok: false,
					erro: "Entre de novo para continuar.",
					sessaoExpirada: true
				};
				return {
					ok: true,
					dados: await admin[acao](dados ?? {}, s, contexto.sessao)
				};
			}
			return {
				ok: false,
				erro: "Ação desconhecida."
			};
		} catch (e) {
			if (e instanceof ErroLoja || e instanceof ErroPagamento) return {
				ok: false,
				erro: e.message
			};
			console.error(`[${acao}]`, e);
			return {
				ok: false,
				erro: "Erro no servidor da loja. Tente de novo em instantes."
			};
		}
	}
	return {
		tratar,
		avisoMercadoPago
	};
}
// nuvem/http.js
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "content-type, x-chave-loja, x-sessao-loja, authorization, apikey, x-client-info",
	"Access-Control-Max-Age": "86400"
};
async function responder(loja, { metodo, caminho, consulta, corpoTexto, chave, sessao, ip }) {
	if (metodo === "OPTIONS") return {
		status: 204,
		json: null
	};
	if (metodo === "GET" && /\/saude\/?$/.test(caminho)) return {
		status: 200,
		json: { ok: true }
	};
	if (/\/mercadopago\/?$/.test(caminho)) {
		let corpo = {};
		try {
			corpo = corpoTexto ? JSON.parse(corpoTexto) : {};
		} catch {
			corpo = {};
		}
		const tipo = corpo.type ?? corpo.topic ?? consulta.get("type") ?? consulta.get("topic");
		const id = corpo.data?.id ?? consulta.get("data.id") ?? consulta.get("id");
		return {
			status: 200,
			json: await loja.avisoMercadoPago({
				tipo,
				id
			}).catch(() => ({ ignorado: true }))
		};
	}
	if (metodo !== "POST") return {
		status: 405,
		json: {
			ok: false,
			erro: "Use POST."
		}
	};
	if (corpoTexto && corpoTexto.length > 2e6) return {
		status: 413,
		json: {
			ok: false,
			erro: "Pedido grande demais."
		}
	};
	let corpo;
	try {
		corpo = JSON.parse(corpoTexto || "{}");
	} catch {
		return {
			status: 400,
			json: {
				ok: false,
				erro: "JSON inválido."
			}
		};
	}
	return {
		status: 200,
		json: await loja.tratar(String(corpo.acao ?? ""), corpo.dados ?? {}, {
			chave,
			sessao,
			ip
		})
	};
}
/** Armazenamento do Supabase (fotos e vídeos dos produtos). O caixa envia o arquivo direto pelo endereço assinado. */
function armazenamentoSupabase({ url, chaveServico, pasta = "midias", enviar = fetch }) {
	const cab = {
		Authorization: `Bearer ${chaveServico}`,
		apikey: chaveServico
	};
	return {
		async assinarEnvio(caminho, mime) {
			const r = await enviar(`${url}/storage/v1/object/upload/sign/${pasta}/${caminho}`, {
				method: "POST",
				headers: {
					...cab,
					"Content-Type": "application/json",
					"x-upsert": "true"
				},
				body: "{}"
			});
			const d = await r.json().catch(() => ({}));
			if (!r.ok || !d.url) throw new Error(`armazenamento: ${d.message ?? d.error ?? r.status}`);
			return {
				url_envio: `${url}/storage/v1${d.url.startsWith("/") ? "" : "/"}${d.url}`,
				metodo: "PUT",
				cabecalhos: {
					"Content-Type": mime,
					"x-upsert": "true"
				},
				url_publica: `${url}/storage/v1/object/public/${pasta}/${caminho}`
			};
		},
		async apagar(urls) {
			const prefixo = `${url}/storage/v1/object/public/${pasta}/`;
			const caminhos = urls.filter((u) => u.startsWith(prefixo)).map((u) => u.slice(prefixo.length));
			if (!caminhos.length) return;
			await enviar(`${url}/storage/v1/object/${pasta}`, {
				method: "DELETE",
				headers: {
					...cab,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({ prefixes: caminhos })
			});
		}
	};
}
// nuvem/funcao.js
function iniciar({ pg, env, conferirSenha, servir = globalThis.Deno?.serve }) {
	const pool = new pg.Pool({
		connectionString: env("SUPABASE_DB_URL"),
		max: 3,
		idleTimeoutMillis: 2e4
	});
	pool.on("error", () => {});
	const db = {
		query: (sql, params = []) => pool.query(sql, params),
		async transaction(fn) {
			const c = await pool.connect();
			try {
				await c.query("begin");
				const r = await fn({ query: (s, p = []) => c.query(s, p) });
				await c.query("commit");
				return r;
			} catch (e) {
				await c.query("rollback").catch(() => {});
				throw e;
			} finally {
				c.release();
			}
		}
	};
	const URL_SUPABASE = env("SUPABASE_URL");
	const segredo = async (nome) => (await pool.query("select valor from segredos where nome = $1", [nome])).rows[0]?.valor ?? null;
	let loja = null;
	let siteAtual;
	async function obterLoja() {
		const siteUrl = await segredo("site_url").catch(() => null);
		if (!loja || siteUrl !== siteAtual) {
			siteAtual = siteUrl;
			loja = criarLojaNuvem({
				db,
				mp: criarMercadoPago({ obterToken: () => segredo("mp_token") }),
				armazenamento: armazenamentoSupabase({
					url: URL_SUPABASE,
					chaveServico: env("SUPABASE_SERVICE_ROLE_KEY")
				}),
				urls: {
					notificacao: `${URL_SUPABASE}/functions/v1/loja/mercadopago`,
					voltar: siteUrl ? `${siteUrl.replace(/\/$/, "")}/#pedido` : null
				},
				conferirSenha
			});
		}
		return loja;
	}
	async function atender(req) {
		const u = new URL(req.url);
		try {
			const r = await responder(await obterLoja(), {
				metodo: req.method,
				caminho: u.pathname,
				consulta: u.searchParams,
				corpoTexto: req.method === "POST" ? await req.text() : "",
				chave: req.headers.get("x-chave-loja"),
				sessao: req.headers.get("x-sessao-loja"),
				ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("cf-connecting-ip") ?? "?"
			});
			return new Response(r.json === null ? null : JSON.stringify(r.json), {
				status: r.status,
				headers: {
					...CORS,
					"Content-Type": "application/json; charset=utf-8"
				}
			});
		} catch (e) {
			console.error(e);
			return new Response(JSON.stringify({
				ok: false,
				erro: "Erro no servidor da loja."
			}), {
				status: 500,
				headers: {
					...CORS,
					"Content-Type": "application/json"
				}
			});
		}
	}
	if (servir) servir(atender);
	return atender;
}
export { iniciar };

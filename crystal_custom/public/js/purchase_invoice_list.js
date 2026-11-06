// Adds "Create Payment Advice" to the Purchase Invoice list's Actions menu.
(() => {
	const settings = frappe.listview_settings["Purchase Invoice"] || {};
	const erpnext_onload = settings.onload;

	settings.onload = function (listview) {
		if (erpnext_onload) erpnext_onload.call(this, listview);
		if (!frappe.model.can_create("Supplier Payment Advice")) return;

		listview.page.add_actions_menu_item(__("Create Payment Advice"), () => {
			const invoices = listview.get_checked_items(true);
			if (!invoices.length) {
				frappe.msgprint(__("Select the invoices to pay first."));
				return;
			}

			frappe
				.call({
					method: "crystal_custom.crystal_customizations.doctype.supplier_payment_advice.supplier_payment_advice.make_advice_from_invoices",
					args: { invoices },
					freeze: true,
				})
				.then((r) => {
					const doc = frappe.model.sync(r.message)[0];
					frappe.set_route("Form", doc.doctype, doc.name);
				});
		});
	};

	frappe.listview_settings["Purchase Invoice"] = settings;
})();

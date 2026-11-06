import frappe

ADVICE_ROW = "Supplier Payment Advice Invoice"


def on_submit(doc, method=None):
    """Mark the advice Paid once all of its Payment Entries are submitted."""
    refresh_advice_status(doc)


def on_cancel(doc, method=None):
    """Free the invoices so the advice can create a fresh Payment Entry.

    Runs before Frappe's back-link check, so clearing the link here is also
    what lets the Payment Entry be cancelled at all.
    """
    unlink_from_advice(doc)


def on_trash(doc, method=None):
    unlink_from_advice(doc)


def unlink_from_advice(doc):
    advices = get_advices(doc.name)
    if not advices:
        return

    frappe.db.set_value(ADVICE_ROW, {"payment_entry": doc.name}, "payment_entry", None)
    for name in advices:
        frappe.get_doc("Supplier Payment Advice", name).update_payment_status()


def refresh_advice_status(doc):
    for name in get_advices(doc.name):
        frappe.get_doc("Supplier Payment Advice", name).update_payment_status()


def get_advices(payment_entry):
    return frappe.get_all(
        ADVICE_ROW,
        filters={"payment_entry": payment_entry, "parenttype": "Supplier Payment Advice"},
        pluck="parent",
        distinct=True,
    )

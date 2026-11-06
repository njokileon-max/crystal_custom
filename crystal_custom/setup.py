import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

ADVICE = "Supplier Payment Advice"
ADVICE_WORKFLOW = "Supplier Payment Advice Approval"
ADVICE_APPROVED_NOTIFICATION = "Supplier Payment Advice Approved"
ADVICE_REJECTED_NOTIFICATION = "Supplier Payment Advice Rejected"
ADVICE_APPROVED_EMAILS = (
    "financemanager@crystaladhesivesltd.com",
    "edwinmjoel@gmail.com",
)


def after_install():
    setup_supplier_payment_advice()


def setup_supplier_payment_advice():
    """Create the Payment Entry back-link and the approval workflow.

    The workflow and notification are created once and never overwritten, so
    Finance can change the approver roles or the email recipients from the desk.
    """
    create_custom_fields(
        {
            "Payment Entry": [
                {
                    "fieldname": "custom_supplier_payment_advice",
                    "label": "Supplier Payment Advice",
                    "fieldtype": "Link",
                    "options": ADVICE,
                    "insert_after": "reference_date",
                    "read_only": 1,
                    "no_copy": 1,
                    "in_standard_filter": 1,
                }
            ]
        },
        update=True,
    )

    create_workflow()
    create_notifications()


def create_workflow():
    if frappe.db.exists("Workflow", ADVICE_WORKFLOW):
        return

    for state, style in (
        ("Draft", ""),
        ("Pending Approval", "Warning"),
        ("Approved", "Success"),
        ("Rejected", "Danger"),
        ("Cancelled", "Danger"),
    ):
        if not frappe.db.exists("Workflow State", state):
            frappe.get_doc(
                {"doctype": "Workflow State", "workflow_state_name": state, "style": style}
            ).insert(ignore_permissions=True)

    for action in ("Submit for Approval", "Approve", "Reject", "Resubmit", "Cancel"):
        if not frappe.db.exists("Workflow Action Master", action):
            frappe.get_doc(
                {"doctype": "Workflow Action Master", "workflow_action_name": action}
            ).insert(ignore_permissions=True)

    preparer, approver = "Accounts User", "Accounts Manager"

    frappe.get_doc(
        {
            "doctype": "Workflow",
            "workflow_name": ADVICE_WORKFLOW,
            "document_type": ADVICE,
            "workflow_state_field": "workflow_state",
            "is_active": 1,
            "send_email_alert": 1,
            "states": [
                {"state": "Draft", "doc_status": "0", "allow_edit": preparer},
                {"state": "Pending Approval", "doc_status": "0", "allow_edit": approver},
                {"state": "Approved", "doc_status": "1", "allow_edit": approver},
                {"state": "Rejected", "doc_status": "0", "allow_edit": preparer},
                {"state": "Cancelled", "doc_status": "2", "allow_edit": approver},
            ],
            "transitions": [
                {"state": "Draft", "action": "Submit for Approval", "next_state": "Pending Approval",
                 "allowed": preparer, "allow_self_approval": 1},
                {"state": "Pending Approval", "action": "Approve", "next_state": "Approved",
                 "allowed": approver, "allow_self_approval": 0},
                {"state": "Pending Approval", "action": "Reject", "next_state": "Rejected",
                 "allowed": approver, "allow_self_approval": 0},
                {"state": "Rejected", "action": "Resubmit", "next_state": "Pending Approval",
                 "allowed": preparer, "allow_self_approval": 1},
                {"state": "Approved", "action": "Cancel", "next_state": "Cancelled",
                 "allowed": approver, "allow_self_approval": 1},
            ],
        }
    ).insert(ignore_permissions=True)

    set_workflow_email_states()


def set_workflow_email_states():
    """Email the role that must act only while an approval is pending.

    Otherwise a new draft would email every Accounts User, and an approved
    advice would prompt every Accounts Manager to cancel it. Frappe never
    sends these to the document's creator, so rejections have their own
    notification.
    """
    for state in frappe.get_all(
        "Workflow Document State", filters={"parent": ADVICE_WORKFLOW}, fields=["name", "state"]
    ):
        frappe.db.set_value(
            "Workflow Document State", state.name, "send_email", state.state.startswith("Pending")
        )
    frappe.clear_cache(doctype=ADVICE)


def create_notifications():
    create_notification(
        ADVICE_APPROVED_NOTIFICATION,
        "Approved",
        # "cc" is Frappe's "always send to these addresses" recipient field.
        {"receiver_by_document_field": "owner", "cc": "\n".join(ADVICE_APPROVED_EMAILS)},
    )
    create_notification(ADVICE_REJECTED_NOTIFICATION, "Rejected", {"receiver_by_document_field": "owner"})


def create_notification(name, state, recipient):
    if frappe.db.exists("Notification", name):
        return

    frappe.get_doc(
        {
            "doctype": "Notification",
            "name": name,
            "subject": "Payment Advice {{ doc.name }}: {{ doc.workflow_state }}",
            "document_type": ADVICE,
            "event": "Value Change",
            "value_changed": "workflow_state",
            "condition": f"doc.workflow_state == '{state}'",
            "channel": "Email",
            "enabled": 1,
            "message_type": "HTML",
            "message": NOTIFICATION_MESSAGE,
            "recipients": [recipient],
        }
    ).insert(ignore_permissions=True)


NOTIFICATION_MESSAGE = """
<p>Payment Advice <a href="{{ frappe.utils.get_url_to_form(doc.doctype, doc.name) }}"><b>{{ doc.name }}</b></a>
is now <b>{{ doc.workflow_state }}</b>.</p>
{% if doc.workflow_state == "Rejected" and doc.rejection_reason %}
<p><b>Reason:</b> {{ doc.rejection_reason }}</p>
{% endif %}
<p>
Company: {{ doc.company }}<br>
Planned payment date: {{ frappe.utils.formatdate(doc.payment_date) }}<br>
Total: <b>{{ frappe.utils.fmt_money(doc.total_amount, currency=doc.paid_from_account_currency) }}</b>
({{ doc.invoice_count }} invoice(s), {{ doc.supplier_count }} supplier(s))
</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
<tr><th>Supplier</th><th>Invoice</th><th>Due Date</th><th>Amount to Pay</th></tr>
{% for row in doc.invoices %}
<tr>
<td>{{ row.supplier_name or row.supplier }}</td>
<td>{{ row.bill_no or row.purchase_invoice }}</td>
<td>{{ frappe.utils.formatdate(row.due_date) }}</td>
<td style="text-align: right;">{{ frappe.utils.fmt_money(row.amount_to_pay, currency=row.currency) }}</td>
</tr>
{% endfor %}
</table>
{% if doc.remarks %}<p><b>Remarks:</b> {{ doc.remarks }}</p>{% endif %}
"""

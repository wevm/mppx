# Alternate payment credential header

Payment challenges may advertise `header="Payment-Authorization"`. Clients send the serialized `Payment` credential in that header, allowing `Authorization` to retain an ordinary Bearer or Basic credential. Omitted `header` parameters remain compatible with the existing `Authorization` behavior.

The header parameter is included in newly advertised challenge ID bindings, while legacy header-less challenge IDs retain their seven-slot binding. Server handlers configure the issued and extracted field through `Mppx.create({ credentialHeader })`; the HTTP client, composed handlers, proxy dispatch, and HTML service-worker retry all honor the advertised header.

Tests cover challenge serialization/binding, alternate-header extraction, and automatic client retry behavior. The corresponding upstream proposal should define `header` as an optional Payment auth-param with `Authorization` as the default and `Payment-Authorization` as the recommended coexistence header.

try {
    var params = JSON.parse(value);
    var payload = {};
    var fields = ['event_date', 'event_id', 'event_nseverity', 'event_opdata',
        'event_recovery_date', 'event_recovery_time', 'event_severity',
        'event_source', 'event_tags', 'event_time', 'event_update_date',
        'event_update_status', 'event_update_time', 'event_value', 'trigger_id',
        'problem_status', 'event_duration', 'event_recovery_id'];
    for (var i = 0; i < fields.length; i++) {
        payload[fields[i]] = params[fields[i]];
    }
    payload.Host = params.host_conn;
    payload.Event = params.event_name;
    payload.notification_type = params.problem_status === 'Resolved' ? 'recovery'
        : String(params.event_update_status) === '1' ? 'update'
        : String(params.event_value) === '0' ? 'recovery' : 'problem';
    var request = new HttpRequest();
    request.addHeader('Content-Type: application/json');
    request.addHeader('Authorization: Bearer ' + params.webhook_token);
    var response = request.post(params.tvymasurl, JSON.stringify(payload));
    if (request.getStatus() !== 200) {
        throw 'HTTP ' + request.getStatus() + ': ' + response;
    }
    return 'OK';
} catch (err) {
    Zabbix.log(3, 'Error webhook de alertas: ' + err);
    throw 'Webhook error: ' + err;
}

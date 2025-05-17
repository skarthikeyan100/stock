import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

class SSEClient {
  static http.Client _client = http.Client();

  static Stream<dynamic> subscribeToSSE(
      {required String url, required Map<String, String> header}) {
    StreamController<dynamic> streamController = StreamController();
    while (true) {
      try {
        var request = http.Request("GET", Uri.parse(url));
        print("Sending request to $url");
        Future<http.StreamedResponse> response = _client.send(request);

        ///Listening to the response as a stream
        response.asStream().listen((data) {
          ///Applying transforms and listening to it
          data.stream
            ..transform(Utf8Decoder()).transform(LineSplitter()).listen(
              (dataLine) {
                dynamic value;
                if (dataLine.startsWith('data')) {
                  value = dataLine.substring(5);
                  // if (value.toString().length > 10) {
                    // print('Add value + $value');
                    streamController.add(value);
                  // }
                }
              },
              onError: (e, s) {
                streamController.addError(e, s);
              },
            );
        }, onError: (e, s) {
          streamController.addError(e, s);
        });
      } catch (e, s) {
        streamController.addError(e, s);
      }

      Future.delayed(Duration(seconds: 1), () {});
      return streamController.stream;
    }
  }

  static void unsubscribeFromSSE() {
    _client.close();
  }
}
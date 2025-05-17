import 'package:http/http.dart' as http;
import 'package:cbse/main.dart';
import 'package:cbse/provider/settings_provider.dart';
import 'package:cbse/util/generic_exception.dart';
import 'dart:convert';
import 'dart:io';

// final String _baseUrl = 'http://aa584b75.ngrok.io/api'; // ngrok

class ApiUtil {
  static const String baseUrl = "http://192.168.0.113:3000";
  
  static String getBaseUrl() {
    //TODO: Initially host will not be set
    String host = SettingsState().host;
   
    // return 'http://$host:3000';
    return baseUrl;
  }
  
  static Future<dynamic> login(String otp) async {
    try {
      String test = '${getBaseUrl()}/login?otp=$otp';
      return await http.get(Uri.parse('${getBaseUrl()}/login?otp=$otp'));
    } on SocketException {
      throw GenericException('No Internet connection');
    }
  }

  static Future<dynamic> get(String url) async {
    dynamic responseJson;
    try {
      print(Uri.parse('${getBaseUrl()}$url').toString());
      final response = await http.get(Uri.parse('${getBaseUrl()}$url'));
      responseJson = _response(response);
    } on SocketException {
      throw GenericException('No Internet connection');
    }
    return responseJson;
  }

  static dynamic _response(http.Response response) {
    switch (response.statusCode) {
      case 200:
        if (response.body.isNotEmpty) {
          try {
            return json.decode(response.body);
          } on FormatException {
            print('Response is ${response.body} and hence sending empty response');
            return {};
          }
        }
        break;
      case 400:
        throw GenericException('Bad Request: ${response.body.toString()}');
      case 401:
      case 403:
        throw GenericException(
            'UnAuthorized Request: ${response.body.toString()}');
      case 500:

      default:
        throw GenericException('Internal Error: ${response.body.toString()}');
    }
  }
}
